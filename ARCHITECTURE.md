# Architecture & Design Notes

This document explains **how the Venice E2EE Proxy works**, the **cryptographic and hardware-attestation dynamics** behind Venice.ai's TEE-backed inference, and **why the code is structured the way it is**. It's meant to capture the *reasoning* — especially the parts (PCCS, GPU confidential computing, the ESM/CJS interop) that are non-obvious from the code alone.

> **TL;DR of the trust model:** Your prompt is encrypted on this proxy and only decrypted *inside* an Intel TDX Trusted Execution Environment (TEE) that we cryptographically verify against **Intel's** root of trust. For inference the plaintext must reach the GPU; on confidential-computing GPUs that hop is also protected, but — and this is important — **this client does not independently verify the GPU's attestation today** (see [§7](#7-confidential-computing-on-the-gpu)).

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Codebase structure](#2-codebase-structure)
3. [Request flows](#3-request-flows)
4. [The E2EE protocol with Venice](#4-the-e2ee-protocol-with-venice)
5. [Attestation: trusting the TEE](#5-attestation-trusting-the-tee)
6. [PCCS: why verification material comes from Intel, not Venice](#6-pccs-why-verification-material-comes-from-intel-not-venice)
7. [Confidential computing on the GPU](#7-confidential-computing-on-the-gpu)
8. [Key design decisions](#8-key-design-decisions)
9. [Threat model: what is and isn't protected](#9-threat-model-what-is-and-isnt-protected)
10. [References](#10-references)

---

## 1. System overview

The proxy is a thin, OpenAI-compatible HTTP server that sits between an OpenAI-compatible client (Cline, the OpenAI SDK, `curl`) and Venice's API. Its job is to make end-to-end encryption **transparent**: clients speak plain OpenAI, and the proxy handles session establishment, encryption, attestation, and on-the-fly decryption for any model whose id starts with `e2ee-`.

```
┌──────────────┐   OpenAI API (plaintext)   ┌────────────────────┐   E2EE (ciphertext)   ┌─────────────────────┐
│   Client     │ ─────────────────────────► │  Venice E2EE Proxy │ ───────────────────►  │   Venice CPU TEE    │
│ (Cline/SDK)  │ ◄───────────────────────── │   (this server)    │ ◄───────────────────  │   (Intel TDX)       │
└──────────────┘   SSE / JSON (plaintext)   └────────────────────┘   encrypted SSE       └──────────┬──────────┘
                                                       │                                             │ confidential
                                                       │ Intel-signed collateral                     │ compute link
                                                       ▼                                             ▼
                                              ┌──────────────────┐                          ┌─────────────────────┐
                                              │  PCCS (Phala)    │                          │  NVIDIA GPU (CC)    │
                                              │  caches Intel PCS│                          │  protected memory   │
                                              └──────────────────┘                          └─────────────────────┘
```

The proxy never persists prompts and only holds the AES key material for the lifetime of a cached session (default 30 min). All cryptography is delegated to the official [`venice-e2ee`](https://github.com/elkimek/venice-e2ee.git) library — we do not implement crypto ourselves.

---

## 2. Codebase structure

NestJS modular layout. Each module owns one concern; the rest of the app depends on small, typed services.

```
src/
├── main.ts                       # Bootstrap + Swagger; delegates global setup to app.setup.ts
├── app.setup.ts                  # Shared global pipes/filters/versioning/CORS (used by app + tests)
├── app.module.ts                 # Root module wiring
│
├── config/                       # Environment configuration
│   ├── env.validation.ts         #   class-validator schema; fails fast on bad config
│   ├── app-config.service.ts     #   typed accessor (no stringly-typed get('KEY') elsewhere)
│   └── config.module.ts          #   global @nestjs/config wiring
│
├── e2ee/                         # The ONLY place that touches venice-e2ee
│   ├── e2ee.service.ts           #   loads the ESM lib, owns the E2EE client + DCAP verifier
│   └── e2ee.module.ts
│
├── chat/                         # POST /v1/chat/completions
│   ├── chat.controller.ts        #   HTTP/SSE writing for all 4 scenarios
│   ├── chat.service.ts           #   orchestration: encrypt → forward → decrypt
│   └── dto/                      #   validated, Swagger-documented request/response DTOs
│
├── models/                       # GET /v1/models (transparent proxy of Venice's catalog)
├── health/                       # GET /healthz (version-neutral liveness probe)
│
└── common/                       # Shared infrastructure
    ├── interfaces/openai.interface.ts   # internal OpenAI response shapes
    ├── utils/openai.util.ts             # id/chunk builders, SSE helpers, isE2EEModel()
    ├── filters/openai-exception.filter.ts # maps errors → OpenAI error envelope
    └── venice/venice-http.service.ts    # upstream HTTP client (global fetch → web streams)
```

**Design intent:** every interaction with `venice-e2ee` is funneled through `E2eeService`. If the library changes (or we swap it), there is exactly one file to touch. Likewise, all upstream HTTP goes through `VeniceHttpService`, which deliberately uses the global `fetch` so response bodies are web `ReadableStream`s — exactly what the library's `decryptStream` consumes.

---

## 3. Request flows

There are four paths, decided by two booleans: **is the model `e2ee-`?** and **did the client ask for `stream`?**

### Non-E2EE (transparent proxy)
The proxy forwards the request to Venice unchanged. Non-streaming returns the JSON body; streaming pipes the upstream SSE bytes straight through. No crypto, no session.

### E2EE, streaming (`stream: true`)
1. `E2eeService.createSession(model)` — fetches the TEE attestation, **verifies it**, and performs ECDH key exchange (cached for `SESSION_TTL_MS`).
2. `E2eeService.encrypt(messages, session)` — AES-256-GCM encrypts each message; returns `encryptedMessages`, TEE headers, and `venice_parameters: { enable_e2ee: true }`.
3. The proxy POSTs to Venice with `stream: true`.
4. `E2eeService.decryptStream(body, session)` decrypts each SSE chunk; the controller re-wraps the plaintext deltas as standard OpenAI `chat.completion.chunk` events, terminated by `data: [DONE]`.

### E2EE, non-streaming (`stream: false` or omitted)
Venice **requires** streaming for E2EE. So the proxy still streams upstream and decrypts, but **buffers** the deltas and returns a single OpenAI `chat.completion` object. This is why non-streaming E2EE requests still work for clients that don't speak SSE — the streaming requirement is an upstream constraint we hide.

---

## 4. The E2EE protocol with Venice

**Protocol:** ECDH (secp256k1) key exchange → HKDF-SHA256 key derivation → AES-256-GCM encryption. All primitives come from audited libraries (`@noble/secp256k1`, `@noble/hashes`, Web Crypto).

```
Proxy (client side)                                   Venice CPU TEE (Intel TDX)
   │                                                          │
   │  1. GET /tee/attestation?model=&nonce= ─────────────────►│
   │◄──── { signing_key, intel_quote, nvidia_payload, ... } ──│
   │                                                          │
   │  2. Verify attestation (see §5)                          │
   │  3. generateKeypair()  → ephemeral secp256k1 keypair     │
   │  4. deriveAESKey(clientPriv, teePubKey) via ECDH+HKDF    │
   │                                                          │
   │  5. encryptMessage(aesKey, prompt)                       │
   │     POST /api/v1/chat/completions  ─────────────────────►│  decrypt inside TEE
   │       X-Venice-TEE-Client-Pub-Key: <client ephemeral>    │  run inference
   │       X-Venice-TEE-Model-Pub-Key:  <model/TEE pub>       │
   │       { messages:[ciphertext], stream:true,              │
   │         venice_parameters:{ enable_e2ee:true } }         │
   │                                                          │
   │◄──── SSE stream, per-chunk encrypted ───────────────────│
   │      each chunk = hex(ephemeralPub ‖ nonce ‖ ciphertext) │
   │                                                          │
   │  6. For each chunk: ECDH(clientPriv, chunkEphPub) →      │
   │     HKDF → AES-GCM decrypt → plaintext token             │
```

Two subtleties worth recording:

- **Per-chunk ephemeral keys.** Every response chunk carries a *fresh* server ephemeral public key, so each chunk requires its own ECDH derivation. The library handles this in `decryptStream`; we just consume plaintext deltas.
- **Plaintext passthrough.** Some tokens (e.g. whitespace) may arrive unencrypted; the library handles that and the `[DONE]` sentinel internally.

Plaintext exists in only two places: **on this proxy** (briefly, in memory) and **inside the TEE**. It never traverses the network in the clear.

---

## 5. Attestation: trusting the TEE

Encrypting to the TEE is pointless unless we can prove the thing we're encrypting *to* is a genuine, non-tampered Intel TDX enclave — and not, say, a man-in-the-middle holding its own key. That proof is **remote attestation**.

On every `createSession`, Venice returns a **TDX quote** (`intel_quote`): a hardware-signed report containing the enclave's measurements and the `REPORTDATA` field, into which Venice binds a client nonce and its signing key's Ethereum address. The quote is signed by a **PCK key** fused into the physical CPU, whose certificate chains to the **Intel SGX Root CA**.

The library runs verification in two tiers:

### Tier 1 — Binding checks (always on when `VERIFY_ATTESTATION=true`)
Parses the quote locally and checks:
1. **Nonce binding** — our client nonce appears in `REPORTDATA` (replay protection).
2. **Signing-key binding** — the signing key's Ethereum address matches `REPORTDATA`.
3. **Debug-mode rejection** — refuses TEEs running in debug mode.
4. **Server cross-check** — flags disagreement with Venice's own `server_verification`.

These need **no external services** — they're pure byte inspection. If any fails, `createSession` throws and the proxy returns a clear `503`.

### Tier 2 — Full DCAP verification (on by default via `VERIFY_DCAP=true`)
Validates the quote against **Intel's** published, signed collateral:
- PCK certificate chain up to the Intel SGX Root CA
- Quote signature (ECDSA P-256)
- Quoting Enclave (QE) identity
- **TCB level evaluation** — is this CPU's microcode/firmware up to date, or affected by an Intel security advisory?
- CRL checks

This is what turns "the quote *looks* well-formed" into "the quote is *cryptographically valid and current*." It's implemented by [`@phala/dcap-qvl`](https://github.com/Phala-Network/dcap-qvl) and requires fetching collateral — which is where PCCS comes in.

> See `src/e2ee/e2ee.service.ts` (`loadDcapVerifier`) for how the verifier is wired in and why a load failure is a hard startup error rather than a silent downgrade.

---

## 6. PCCS: why verification material comes from Intel, not Venice

**PCCS = Provisioning Certificate Caching Service.**

To verify a TDX quote you need Intel-signed collateral (PCK certs, TCB Info, QE Identity, CRLs). Intel publishes this from its **PCS** (Provisioning Certification Service) at `api.trustedservices.intel.com`. Hitting Intel directly is awkward — it's rate-limited and some endpoints require a registered subscription key — so the ecosystem runs **PCCS** servers that fetch from Intel once and cache the material. **Phala operates a free public PCCS** at `pccs.phala.network`, which is `@phala/dcap-qvl`'s default and therefore ours.

```
        TDX quote                       Intel-signed collateral
Venice ──────────────►  this proxy  ◄──────────────────────────  PCCS (Phala)  ◄──  Intel PCS
 TEE   (attestation)        │            (PCK chain, TCB,                           (api.trusted
                            ▼             QE identity, CRLs)                          services.intel.com)
                  @phala/dcap-qvl verifies LOCALLY:
                  quote signature ✔   cert chain → Intel root ✔   TCB level ✔
```

### Why not get the collateral from Venice?

1. **Trust independence (the fundamental reason).** Venice is *the party being verified*. The entire point of attestation is to confirm Venice's enclave is genuine **without trusting Venice's word**. The root of trust is **Intel**, not Venice. Venice does run its own server-side check (surfaced as `server_verification` / `serverTdxValid`), but client-side DCAP re-derives trust from Intel-rooted, Intel-signed material, so a compromised or dishonest Venice cannot fabricate a passing result.

   *(Technically the collateral is Intel-signed, so even Venice-served collateral would be cryptographically checkable — but fetching independently also guarantees **freshness**: we pick up revocations and TCB downgrades immediately rather than whatever an intermediary chose to cache.)*

2. **Practical.** Collateral is shared across all Intel TDX machines and changes slowly; a dedicated caching layer handles Intel's rate limits and availability far better than expecting each inference provider to redistribute it.

### Operational notes
- Default: Phala's public PCCS (zero setup), set via `DCAP_PCCS_URL` (defaults to Phala when unset).
- **Production tip:** run your own PCCS (or point at a corporate one) and set `DCAP_PCCS_URL`, so you don't depend on a third party's uptime and you control caching.
- DCAP requires **outbound network to the PCCS** at session-creation time. The lightweight Tier-1 checks do not.

---

## 7. Confidential computing on the GPU

This is the part most people miss, and it's a genuine trust boundary worth documenting.

### The problem
The prompt is decrypted **inside the CPU TEE** (an Intel TDX confidential VM). But LLM inference runs on a **GPU**, which is a separate PCIe device managed by the host. Naively, the moment the CPU TEE hands data to the GPU, it would cross the host's memory/bus — where a malicious hypervisor or host OS could read it. That would defeat the entire E2EE guarantee.

### How modern GPUs close the gap (NVIDIA Confidential Computing)
NVIDIA **Confidential Computing (CC)** mode — introduced on **Hopper (H100)** and continued on newer generations — extends the TEE boundary to the GPU:

- **Isolated GPU memory.** In CC mode the GPU's on-board memory (HBM) is access-controlled so the host/hypervisor **cannot read or write** it. Compute happens on plaintext *inside* this protected region only.
- **Encrypted data-in-transit over PCIe.** The PCIe bus itself isn't secret, so data moving between the confidential VM and the GPU is **encrypted and integrity-protected (AES-GCM)**. DMA goes through shared "bounce buffers", but their *contents* are ciphertext — the trusted GPU driver *inside* the CVM encrypts before transfer and the GPU decrypts within its trust boundary (and vice versa for results). The host sees only ciphertext.
- **A secure CPU↔GPU channel.** Before any secrets flow, the CVM and GPU establish keys over an **SPDM**-secured session.
- **GPU attestation with NVIDIA as root of trust.** Each CC-capable GPU has a unique device identity/certificate issued by **NVIDIA**, plus measurements of its firmware/VBIOS. These are verified (e.g. via NVIDIA's Remote Attestation Service or a local verifier with NVIDIA's cert chain) — exactly analogous to Intel's role for the CPU TEE. So the GPU's root of trust is **NVIDIA**, just as the CPU's is **Intel**.

So your mental model is correct: **plaintext only ever exists inside the CPU TEE and inside the GPU's protected memory; it travels encrypted between them and is never exposed to the host.**

```
   Intel TDX CVM (CPU TEE)                          NVIDIA GPU (CC mode)
 ┌──────────────────────────┐   encrypted (AES-GCM) ┌───────────────────────────┐
 │ prompt decrypted here     │   over PCIe via       │ decrypted only inside     │
 │ trusted GPU driver        │ ═════════════════════►│ protected HBM; inference  │
 │ encrypts before DMA       │   (bounce buffers =   │ runs on plaintext here    │
 │                           │◄═════════════════════ │ results encrypted back    │
 └──────────────────────────┘    ciphertext)         └───────────────────────────┘
        root of trust: Intel                                root of trust: NVIDIA
                         host / hypervisor sees only ciphertext
```

### ⚠️ Where Venice and *this* client actually stand
This matters — don't overstate the guarantee. There are **two distinct levels** of "verifying GPU attestation":

1. **Enforcing Venice's GPU verdict (what this proxy does, on by default).**
   With `VERIFY_GPU_ATTESTATION=true`, before each E2EE session `E2eeService.enforceGpuAttestation()` fetches `/tee/attestation` directly with a fresh 32-byte nonce and:
   - requires `verified === true` and a matching nonce (replay protection);
   - for models that return GPU evidence (`nvidia_payload`), requires Venice's server-side NVIDIA verification (`server_verification.nvidia.valid`) to pass — otherwise it **fails closed** with a `503`.
   This guarantees a GPU-backed model isn't used unless its GPU attestation passed *on Venice's side*. Results are cached per model for `SESSION_TTL_MS`.

2. **Independent client-side GPU verification (NOT done today).**
   Re-verifying the `nvidia_payload` ourselves against **NVIDIA's** root of trust is not currently feasible because:
   - the `venice-e2ee` library doesn't expose the raw GPU evidence on the session path (so we fetch attestation separately just for the gate);
   - there is **no audited JS/TS NVIDIA GPU attestation verifier** — NVIDIA's tooling is the Python `nv-attestation-sdk` or the remote **NRAS** service (`nras.attestation.nvidia.com`);
   - independent freshness requires the *verifier* to control the nonce bound into the GPU evidence, which Venice's API does not currently expose for the GPU quote.

**Consequence:** what we *cryptographically and independently* verify end-to-end is the **CPU TEE (Intel TDX)** (binding checks + full DCAP against Intel's root of trust). For the **GPU** we currently **enforce Venice's verdict** rather than independently re-deriving it. `enforceGpuAttestation()` is deliberately the insertion point where a future **NRAS-based independent check** would slot in — that's the natural next enhancement if your threat model needs it.

---

## 8. Key design decisions

### ESM-only dependency, CommonJS app — the `import()` shim
`venice-e2ee` is published **ESM-only** (`"type": "module"`, no `require` export condition). The NestJS app compiles to **CommonJS**. A normal `import` would be down-leveled by TypeScript to `require()` and fail at runtime with `ERR_REQUIRE_ESM` / `ERR_PACKAGE_PATH_NOT_EXPORTED`. To bridge this we use a dynamic import that TypeScript will not rewrite:

```ts
const importEsm = new Function('specifier', 'return import(specifier);') as <T>(s: string) => Promise<T>;
```

This keeps a *true* `import()` in the emitted JS, so we load the ESM module (and its `venice-e2ee/dcap` subpath) from CommonJS. We chose this over converting the whole app to ESM (more friction with the Nest toolchain) or vendoring the lib (GPL-3.0 implications + maintenance). Types are imported normally via `import type`, which is erased at compile time.

> Note: `@noble/secp256k1@2` is itself ESM-only; Node ≥20.19 / ≥22 supports `require()` of synchronous ESM, so this works on the project's Node baseline.

### E2EE forces streaming; non-streaming is buffered
Venice requires `stream: true` for E2EE. Rather than reject non-streaming requests (poor UX for simple clients), the proxy streams upstream, decrypts, and **buffers** into a single completion. The constraint is upstream's; we hide it.

### Security-by-default toggles
- **Full DCAP** (`VERIFY_DCAP=true`) unless deliberately disabled. A failure to load the DCAP verifier is a **hard startup error** (with a remediation hint) rather than a silent downgrade. DCAP only runs as part of attestation, so enabling it while `VERIFY_ATTESTATION=false` logs a no-op warning.
- **GPU attestation enforcement** (`VERIFY_GPU_ATTESTATION=true`): GPU-backed E2EE models fail closed unless their NVIDIA attestation passed Venice's verification (see [§7](#7-confidential-computing-on-the-gpu)). Both are on by default and can be explicitly disabled via env.

### OpenAI-shaped everything
A global exception filter renders all errors in the OpenAI `{ error: { message, type, ... } }` envelope, and URI versioning puts endpoints under `/v1/*`, so off-the-shelf OpenAI clients (Cline, the OpenAI SDK) work unmodified.

---

## 9. Threat model: what is and isn't protected

**Protected / verified:**
- Prompts and completions are encrypted in transit and only decrypted inside the Intel TDX TEE (and the GPU's protected memory).
- The CPU TEE's authenticity and integrity are independently verified against **Intel's** root of trust (signature chain + TCB level via DCAP).
- **GPU attestation is enforced by default** (`VERIFY_GPU_ATTESTATION`): a GPU-backed model is rejected unless its NVIDIA attestation passed Venice's server-side verification (fail-closed). See the important caveat below.
- Replay protection (nonce binding) and signing-key binding.
- Debug-mode TEEs are rejected.

**Enforced-but-not-independently-verified (by default):**
- **NVIDIA GPU attestation** (`nvidia_payload`) — the proxy *enforces* Venice's server-side GPU verdict (fail-closed) but does **not** independently re-verify the NVIDIA quote against NVIDIA's root of trust. See [§7](#7-confidential-computing-on-the-gpu).

**Not verified / trust assumptions (by default):**
- **TEE code measurements** — Venice does not publish expected measurement values yet, so we can't pin them.
- **This proxy itself** sees plaintext in memory. Run it somewhere you trust (ideally the same trust domain as the client). It is the client's edge of the E2EE channel.
- `VENICE_API_KEY` is a secret held by the proxy; clients connecting to the proxy do not need a real key.

---

## 10. References

- `venice-e2ee` library (protocol, attestation, crypto): <https://github.com/elkimek/venice-e2ee.git>
- `@phala/dcap-qvl` (Intel TDX DCAP quote verification): <https://github.com/Phala-Network/dcap-qvl>
- Intel SGX/TDX DCAP & Provisioning Certification Service (PCS/PCCS) — Intel Trusted Services documentation.
- NVIDIA Confidential Computing (Hopper H100 and later) — NVIDIA Confidential Computing documentation.
- This repository: `README.md` (setup/usage) and `src/e2ee/e2ee.service.ts` (the single integration point with the library).
