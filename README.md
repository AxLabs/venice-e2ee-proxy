# Venice E2EE Proxy

A lightweight, **OpenAI-compatible proxy** that adds **end-to-end encryption (E2EE)** for [Venice.ai](https://venice.ai)'s TEE-backed models. Point any OpenAI-compatible tool — Hermes, Jan, Cline, Continue, etc — at it and talk to Venice's confidential models without writing a single line of crypto.

When you call a model whose id starts with `e2ee-`, the proxy encrypts your messages client-side; they are only decrypted inside Venice's Intel TDX **Trusted Execution Environment** — Venice never sees your plaintext. Every other model is proxied straight through, unchanged.

---

## Quick start

The fastest way to run the proxy — **no clone, no build**. All you need is **Node.js 20+** and a **Venice API key**.

```bash
npx @axlabs/venice-e2ee-proxy --venice-api-key sk-your-venice-key
```

You should see:

```
Venice E2EE Proxy listening on http://0.0.0.0:4337
OpenAI-compatible base URL: http://0.0.0.0:4337/v1 (also accepts http://0.0.0.0:4337/api/v1)
Swagger UI: http://0.0.0.0:4337/docs
```

That's it. Now point any OpenAI-compatible client at `http://localhost:4337/v1` and use an `e2ee-` model:

```bash
curl http://localhost:4337/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "e2ee-qwen3-5-122b-a10b",
    "messages": [{ "role": "user", "content": "Hello from the encrypted side" }]
  }'
```

> **Requirements:** Node.js 20+. All dependencies (including the [`@axlabs/venice-e2ee`](https://github.com/AxLabs/venice-e2ee) encryption library) install straight from npm.

### Other ways to run it

```bash
# Pin a specific version
npx @axlabs/venice-e2ee-proxy@1.0.1 --venice-api-key sk-...

# Install globally, then run the command directly
npm install -g @axlabs/venice-e2ee-proxy
venice-e2ee-proxy --venice-api-key sk-...

# See every available option
npx @axlabs/venice-e2ee-proxy --help
```

Prefer to run from a checkout for development? See [Run from source](#run-from-source).

---

## Configuration

Configure the proxy whichever way fits your workflow: **CLI flags**, **environment variables**, or a **`.env` file** in the current directory.

**Precedence (highest wins):** CLI flags → environment variables → `.env` file → built-in defaults.

```bash
# Everything via CLI flags
npx @axlabs/venice-e2ee-proxy --venice-api-key sk-... --port 8080 --log-level debug

# API key from the environment, port from a flag
VENICE_API_KEY=sk-... npx @axlabs/venice-e2ee-proxy --port 8080

# From a .env file in the current directory (CLI flags still win)
echo "VENICE_API_KEY=sk-..." > .env
npx @axlabs/venice-e2ee-proxy
```

The only **required** setting is your Venice API key (`--venice-api-key` / `VENICE_API_KEY`). Everything else has a sensible default. Configuration is validated at startup, so mistakes fail fast with a clear message.

| CLI flag | Env variable | Default | Description |
| -------- | ------------ | ------- | ----------- |
| `--venice-api-key <key>` | `VENICE_API_KEY` | — | Your Venice API key (**required**). |
| `-p`, `--port <port>` | `PORT` | `4337` | Port to listen on. |
| `--host <host>` | `HOST` | `0.0.0.0` | Interface to bind. |
| `--session-ttl-ms <ms>` | `SESSION_TTL_MS` | `1800000` (30 min) | E2EE session cache TTL in milliseconds. |
| `--verify-attestation <bool>` | `VERIFY_ATTESTATION` | `true` | Verify TEE attestation on session creation. |
| `--no-verify-attestation` | `VERIFY_ATTESTATION` | — | Shorthand to disable attestation verification. |
| `--verify-dcap <bool>` | `VERIFY_DCAP` | `true` | Run full TDX DCAP verification via `@phala/dcap-qvl`. Only effective when `VERIFY_ATTESTATION=true`. |
| `--no-verify-dcap` | `VERIFY_DCAP` | — | Shorthand to disable DCAP verification. |
| `--verify-gpu-attestation <bool>` | `VERIFY_GPU_ATTESTATION` | `true` | Enforce NVIDIA GPU attestation before each E2EE session. See [ARCHITECTURE.md §7](./ARCHITECTURE.md#7-confidential-computing-on-the-gpu). |
| `--no-verify-gpu-attestation` | `VERIFY_GPU_ATTESTATION` | — | Shorthand to disable GPU attestation enforcement. |
| `--dcap-pccs-url <url>` | `DCAP_PCCS_URL` | Phala PCCS | Optional PCCS server URL for DCAP collateral fetching. |
| `--base-url <url>` | `BASE_URL` | `https://api.venice.ai` | Venice API base URL. |
| `--max-body-size <size>` | `MAX_BODY_SIZE` | `25mb` | Max request body size (any `bytes`-compatible value). |
| `--log-level <level>` | `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` \| `verbose`. Secrets and prompt contents are never logged. |

Boolean flags accept `true`/`false`, `1`/`0`, `yes`/`no`, or `on`/`off`. Every flag has an environment-variable equivalent (see the `Env variable` column above) — handy for Docker, systemd, or CI. A `.env` file in the working directory is loaded automatically; copy [`.env.example`](./.env.example) to get started.

---

## Connect your client

The proxy speaks the **OpenAI API**, so it works with **any client, IDE, or agent that supports an OpenAI-compatible endpoint** — chat UIs, coding assistants, autonomous agents, SDKs, and scripts alike. There's no special integration: just point the tool at the proxy.

Wherever the tool asks for an OpenAI-compatible provider, set:

- **Base URL:** `http://localhost:4337/v1` (the Venice-style `http://localhost:4337/api/v1` also works)
- **API key:** any non-empty value (the proxy uses your own `VENICE_API_KEY` upstream — clients don't need a real key)
- **Model:** an `e2ee-` model (e.g. `e2ee-qwen3-5-122b-a10b`) for encrypted inference, or any regular Venice model id

A few tools that work out of the box: [Jan](https://jan.ai), [Open WebUI](https://openwebui.com), [Cline](https://cline.bot), [Continue](https://continue.dev), [Roo Code](https://roocode.com), [Hermes](https://hermes-agent.nousresearch.com), [OpenClaw](https://openclaw.ai), [LibreChat](https://www.librechat.ai), and the official OpenAI SDKs — among many others. See [Compatible tools](#compatible-tools) below.

> **Tip:** Some "OpenAI Compatible" providers (e.g. Cline) have no model picker — type the model id by hand. The proxy logs the available `e2ee-` model ids at startup for easy copy-paste.

---

## API

### `GET /v1/models`

Returns the available models in OpenAI list format.

```bash
curl http://localhost:4337/v1/models
```

### `POST /v1/chat/completions`

OpenAI-compatible chat completions (streaming and non-streaming).

**Non-streaming, E2EE:**

```bash
curl http://localhost:4337/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "e2ee-qwen3-5-122b-a10b",
    "messages": [{ "role": "user", "content": "Hello from the encrypted side" }]
  }'
```

**Streaming, E2EE (SSE):**

```bash
curl -N http://localhost:4337/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "e2ee-qwen3-5-122b-a10b",
    "messages": [{ "role": "user", "content": "Stream me a haiku" }],
    "stream": true
  }'
```

### Swagger UI

Interactive API documentation is served at **[http://localhost:4337/docs](http://localhost:4337/docs)** (OpenAPI JSON at `/docs-json`).

### Health check

`GET /healthz` → `{ "status": "ok", "uptime": <seconds> }`

---

## How it works

```
┌─────────┐    OpenAI API     ┌──────────────────┐   encrypted (E2EE)   ┌──────────────┐
│  Cline  │ ───────────────►  │ Venice E2EE Proxy │ ──────────────────► │  Venice TEE  │
│ /OpenAI │ ◄───────────────  │   (this server)   │ ◄────────────────── │  (Intel TDX) │
└─────────┘  plaintext SSE    └──────────────────┘   encrypted stream    └──────────────┘
```

- **`e2ee-*` models** → the proxy creates a verified TEE session, encrypts prompts and tool-result bodies, forwards them to Venice with `venice_parameters: { enable_e2ee: true }`, and decrypts the streamed response on the fly. Tool names, schemas, call ids, and arguments stay plaintext (the enclave reads them as JSON). A tool call is returned as `delta.tool_calls` with `finish_reason: "tool_calls"`, so an agent can run the tool and send the result back without the history being flattened to text.
- **All other models** → the request is proxied straight through to Venice unchanged.

**Under the hood:** NestJS (TypeScript, strict mode); encryption via the [`@axlabs/venice-e2ee`](https://github.com/AxLabs/venice-e2ee) library (ECDH secp256k1 → HKDF-SHA256 → AES-256-GCM + TEE attestation); Swagger UI at `/docs`.

> **Note:** Venice requires `stream: true` for E2EE models. If a client sends a non-streaming request to an `e2ee-` model, the proxy transparently streams upstream, buffers the decrypted output, and returns a single OpenAI `chat.completion` object — so non-streaming clients still work.

> 📐 For the deeper "why" — the E2EE/TEE protocol dynamics, why DCAP collateral comes from Intel via **PCCS** (not Venice), how **NVIDIA GPU confidential computing** extends the trust boundary, and the project's design decisions — see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## Run from source

For local development or contributing, run the proxy from a checkout:

```bash
# 1. Install dependencies (a .nvmrc pins Node 24; run `nvm use` first)
npm install

# 2. Configure
cp .env.example .env   # then edit .env and set VENICE_API_KEY

# 3. Start with hot reload
npm run start:dev

# …or build and run the compiled output
npm run build
npm start
```

You can also run the local build through `npx` from the repo root: `VENICE_API_KEY=sk-... npx .`.

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
├── e2ee/                    # Wrapper around the @axlabs/venice-e2ee library
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

Tests run fully offline — the `@axlabs/venice-e2ee` library and the upstream HTTP client are mocked, so no API key or network access is required.

---

## Security notes

- Attestation verification is **on by default**. If the TEE attestation fails (nonce binding, signing-key binding, or debug-mode detection), session creation fails and the proxy returns a clear `503` error.
- **Full TDX DCAP verification is also on by default** (PCK certificate chain, quote signature, QE identity, and TCB evaluation) via [`@phala/dcap-qvl`](https://github.com/Phala-Network/dcap-qvl). It runs as part of attestation and fetches collateral from a PCCS server (Phala's by default; override with `DCAP_PCCS_URL`). Disable it with `VERIFY_DCAP=false`. Note this requires outbound network access to the PCCS at runtime.
- **GPU attestation enforcement is on by default** (`VERIFY_GPU_ATTESTATION`). Before each E2EE session the proxy fetches `/tee/attestation`, checks `verified` + nonce, and — for GPU-backed models — requires Venice's server-side NVIDIA verification to pass, failing closed otherwise. **Caveat:** this enforces Venice's GPU verdict; it is **not yet an independent client-side verification** of the NVIDIA quote (no audited JS verifier exists today — see [ARCHITECTURE.md §7](./ARCHITECTURE.md#7-confidential-computing-on-the-gpu)).
- Treat your `VENICE_API_KEY` as a secret. The proxy adds the `Authorization` header upstream; clients connecting to the proxy do not need to provide a real key.

---

## Compatible tools

Because the proxy exposes a standard **OpenAI-compatible API**, it drops into virtually any OpenAI-compatible client, IDE, or agent — just set the base URL to the proxy. A few popular ones:

<table>
  <tr>
    <td align="center" width="110"><a href="https://jan.ai"><img src="https://github.com/janhq.png" width="56" height="56" alt="Jan logo"><br/>Jan</a></td>
    <td align="center" width="110"><a href="https://openwebui.com"><img src="https://github.com/open-webui.png" width="56" height="56" alt="Open WebUI logo"><br/>Open WebUI</a></td>
    <td align="center" width="110"><a href="https://cline.bot"><img src="https://github.com/cline.png" width="56" height="56" alt="Cline logo"><br/>Cline</a></td>
    <td align="center" width="110"><a href="https://continue.dev"><img src="https://github.com/continuedev.png" width="56" height="56" alt="Continue logo"><br/>Continue</a></td>
  </tr>
  <tr>
    <td align="center" width="110"><a href="https://roocode.com"><img src="https://github.com/RooCodeInc.png" width="56" height="56" alt="Roo Code logo"><br/>Roo Code</a></td>
    <td align="center" width="110"><a href="https://hermes-agent.nousresearch.com"><img src="https://github.com/NousResearch.png" width="56" height="56" alt="Hermes / Nous Research logo"><br/>Hermes</a></td>
    <td align="center" width="110"><a href="https://openclaw.ai"><img src="https://github.com/openclaw.png" width="56" height="56" alt="OpenClaw logo"><br/>OpenClaw</a></td>
    <td align="center" width="110"><a href="https://www.librechat.ai"><img src="https://github.com/danny-avila.png" width="56" height="56" alt="LibreChat logo"><br/>LibreChat</a></td>
  </tr>
</table>

…plus the official **OpenAI SDKs** (Python, Node, …), [LangChain](https://www.langchain.com), [LlamaIndex](https://www.llamaindex.ai), the [Vercel AI SDK](https://sdk.vercel.ai), and any other tool or script that lets you point at an OpenAI-compatible base URL.

> Logos belong to their respective projects and are shown only to indicate compatibility; this does not imply any affiliation or endorsement.

---

## Development & releases (maintainers)

- **CI:** [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) builds, lints, and tests on **every commit** and pull request, on **self-hosted runners**, using the Node version from `.nvmrc`. CI does not publish.
- **Releases:** cut **locally** with a script that bumps the version, tags, pushes, and publishes to npm (so the proxy stays runnable via `npx`).

```bash
npm login                 # one-time: must have access to the @axlabs scope

npm run release -- patch  # 1.0.0 -> 1.0.1   (bug fixes)
npm run release -- minor  # 1.0.0 -> 1.1.0   (new features)
npm run release -- major  # 1.0.0 -> 2.0.0   (breaking changes)
# or an explicit version:
npm run release -- 1.2.3
```

The release script ([`scripts/release.sh`](./scripts/release.sh)) runs pre-flight checks (clean `main`, in sync with origin, npm auth), then `npm ci` + lint + test + build, bumps the version with an annotated `vX.Y.Z` tag, pushes the commit and tag, publishes to npm, and (if `gh` is installed) creates a GitHub Release.

See **[DEVELOPMENT.md](./DEVELOPMENT.md)** for the full guide, the manual fallback, and release verification.

---

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).

> ⚠️ **Heads-up:** this proxy depends on [`@axlabs/venice-e2ee`](https://github.com/AxLabs/venice-e2ee), which is **GPL-3.0**. Running the proxy (including as a hosted service) is unaffected, but **distributing** a build that bundles that library brings the combined work under GPL-3.0. See [NOTICE.md](./NOTICE.md) for details and the full third-party license list.
