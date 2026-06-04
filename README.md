# Venice E2EE Proxy

A lightweight, production-ready **OpenAI-compatible proxy** that adds **end-to-end encryption (E2EE)** for [Venice.ai](https://venice.ai)'s TEE-backed models.

Point any OpenAI-compatible tool (e.g. **Cline** in VS Code, the OpenAI SDK, `curl`) at this server. When you use a model whose id starts with `e2ee-`, requests are encrypted client-side and only decrypted inside Venice's Intel TDX **Trusted Execution Environment** — Venice never sees your plaintext. All cryptography is handled by the official [`venice-e2ee`](https://github.com/elkimek/venice-e2ee) library.

- **Framework:** NestJS (TypeScript, strict mode)
- **Docs:** Swagger UI at `/docs`
- **Encryption:** `venice-e2ee` (ECDH secp256k1 → HKDF-SHA256 → AES-256-GCM + TEE attestation)
- **Endpoints:** `GET /v1/models`, `POST /v1/chat/completions` (streaming + non-streaming)

> 📐 For the deeper "why" — the E2EE/TEE protocol dynamics, why DCAP collateral comes from Intel via **PCCS** (not Venice), how **NVIDIA GPU confidential computing** extends the trust boundary, and the project's design decisions — see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## How it works

```
┌─────────┐    OpenAI API     ┌──────────────────┐   encrypted (E2EE)   ┌──────────────┐
│  Cline  │ ───────────────►  │ Venice E2EE Proxy │ ──────────────────► │  Venice TEE  │
│ /OpenAI │ ◄───────────────  │   (this server)   │ ◄────────────────── │  (Intel TDX) │
└─────────┘  plaintext SSE    └──────────────────┘   encrypted stream    └──────────────┘
```

- **`e2ee-*` models** → the proxy creates a verified TEE session, encrypts your messages, forwards them to Venice with `venice_parameters: { enable_e2ee: true }`, and decrypts the streamed response on the fly.
- **All other models** → the request is proxied straight through to Venice unchanged.

> **Note:** Venice requires `stream: true` for E2EE models. If a client sends a non-streaming request to an `e2ee-` model, the proxy transparently streams upstream, buffers the decrypted output, and returns a single OpenAI `chat.completion` object — so non-streaming clients still work.

---

## Quick start

### Prerequisites

- Node.js 20+ (a `.nvmrc` pins Node 24; run `nvm use`)
- A Venice API key

### Install & run

```bash
# 1. Clone and install
npm install

# 2. Configure
cp .env.example .env
# edit .env and set VENICE_API_KEY

# 3. Build & start
npm run build
npm start
```

Or for development with hot reload:

```bash
npm run start:dev
```

You should see:

```
Venice E2EE Proxy listening on http://0.0.0.0:3000
OpenAI-compatible base URL: http://0.0.0.0:3000/v1
Swagger UI: http://0.0.0.0:3000/docs
```

### Run without cloning (npx)

Once built, the package exposes a `venice-e2ee-proxy` bin. You can run it directly from the repo:

```bash
VENICE_API_KEY=sk-... npx .
```

---

## Configuration

All configuration is via environment variables (loaded from `.env` if present). The environment is validated at startup, so misconfiguration fails fast with a clear message.

| Variable             | Required | Default                 | Description                                              |
| -------------------- | -------- | ----------------------- | -------------------------------------------------------- |
| `VENICE_API_KEY`     | ✅       | —                       | Your Venice API key.                                     |
| `PORT`               |          | `3000`                  | Port to listen on.                                       |
| `HOST`               |          | `0.0.0.0`               | Interface to bind.                                       |
| `SESSION_TTL_MS`     |          | `1800000` (30 min)      | E2EE session cache TTL in milliseconds.                  |
| `VERIFY_ATTESTATION` |          | `true`                  | Verify TEE attestation on session creation.              |
| `VERIFY_DCAP`        |          | `true`                  | Run full TDX DCAP verification (cert chain, quote signature, TCB) via `@phala/dcap-qvl`. Only effective when `VERIFY_ATTESTATION=true`. |
| `DCAP_PCCS_URL`      |          | Phala PCCS              | Optional PCCS server URL for DCAP collateral fetching.   |
| `VERIFY_GPU_ATTESTATION` |      | `true`                  | Enforce NVIDIA GPU attestation before each E2EE session (fails closed for GPU-backed models). Enforces Venice's server-side GPU verdict — not yet an independent client-side check. See [ARCHITECTURE.md §7](./ARCHITECTURE.md#7-confidential-computing-on-the-gpu). |
| `BASE_URL`           |          | `https://api.venice.ai` | Venice API base URL.                                     |
| `LOG_LEVEL`          |          | `info`                  | Logging verbosity: `error` \| `warn` \| `info` \| `debug` \| `verbose` (cumulative). Use `debug` for detailed per-request tracing. Secrets and prompt contents are never logged. |

---

## API

### `GET /v1/models`

Returns the available models in OpenAI list format.

```bash
curl http://localhost:3000/v1/models
```

### `POST /v1/chat/completions`

OpenAI-compatible chat completions (streaming and non-streaming).

**Non-streaming, E2EE:**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "e2ee-qwen3-5-122b-a10b",
    "messages": [{ "role": "user", "content": "Hello from the encrypted side" }]
  }'
```

**Streaming, E2EE (SSE):**

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "e2ee-qwen3-5-122b-a10b",
    "messages": [{ "role": "user", "content": "Stream me a haiku" }],
    "stream": true
  }'
```

### Swagger UI

Interactive API documentation is served at **[http://localhost:3000/docs](http://localhost:3000/docs)** (OpenAPI JSON at `/docs-json`).

### Health check

`GET /healthz` → `{ "status": "ok", "uptime": <seconds> }`

---

## Using with Cline (VS Code)

1. Start the proxy (`npm start`).
2. In Cline settings, choose **OpenAI Compatible** as the API provider.
3. Set:
   - **Base URL:** `http://localhost:3000/v1` (the Venice-style `http://localhost:3000/api/v1` also works — both prefixes are accepted).
   - **API Key:** any non-empty value (the proxy uses your `VENICE_API_KEY` from `.env`; the client key is not required).
   - **Model ID:** an `e2ee-` model such as `e2ee-qwen3-5-122b-a10b` for encrypted inference, or any regular Venice model id.

---

## Project structure

```
src/
├── main.ts                  # Bootstrap + Swagger setup
├── app.module.ts            # Root module
├── app.setup.ts             # Shared global pipes/filters/versioning/CORS
├── config/                  # Env configuration + validation
│   ├── config.module.ts
│   ├── app-config.service.ts
│   └── env.validation.ts
├── e2ee/                    # Wrapper around the venice-e2ee library
│   ├── e2ee.module.ts
│   └── e2ee.service.ts
├── chat/                    # Chat completions controller + service
│   ├── chat.controller.ts
│   ├── chat.service.ts
│   └── dto/
├── models/                  # Models controller + service
├── health/                  # Liveness probe
└── common/                  # Shared interfaces, utils, filters, HTTP client
test/
├── openai.util.spec.ts      # Unit tests for OpenAI helpers
├── openai-compliance.spec.ts # API compliance + E2EE behavior tests
└── helpers/test-app.ts      # Test harness with mocked upstream + E2EE
```

---

## Testing

The suite uses **Vitest** and verifies:

- The server returns proper OpenAI-shaped responses (`/v1/models`, `chat.completion`).
- Streaming works correctly (SSE with `chat.completion.chunk` events and a `[DONE]` sentinel).
- `e2ee-` models are handled via the encryption path (session creation + encryption) while regular models are proxied straight through.

```bash
npm test          # run once
npm run test:watch
```

Tests run fully offline — the `venice-e2ee` library and the upstream HTTP client are mocked, so no API key or network access is required.

---

## Security notes

- Attestation verification is **on by default**. If the TEE attestation fails (nonce binding, signing-key binding, or debug-mode detection), session creation fails and the proxy returns a clear `503` error.
- **Full TDX DCAP verification is also on by default** (PCK certificate chain, quote signature, QE identity, and TCB evaluation) via [`@phala/dcap-qvl`](https://github.com/Phala-Network/dcap-qvl). It runs as part of attestation and fetches collateral from a PCCS server (Phala's by default; override with `DCAP_PCCS_URL`). Disable it with `VERIFY_DCAP=false`. Note this requires outbound network access to the PCCS at runtime.
- **GPU attestation enforcement is on by default** (`VERIFY_GPU_ATTESTATION`). Before each E2EE session the proxy fetches `/tee/attestation`, checks `verified` + nonce, and — for GPU-backed models — requires Venice's server-side NVIDIA verification to pass, failing closed otherwise. **Caveat:** this enforces Venice's GPU verdict; it is **not yet an independent client-side verification** of the NVIDIA quote (no audited JS verifier exists today — see [ARCHITECTURE.md §7](./ARCHITECTURE.md#7-confidential-computing-on-the-gpu)).
- Treat your `VENICE_API_KEY` as a secret. The proxy adds the `Authorization` header upstream; clients connecting to the proxy do not need to provide a real key.

---

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
