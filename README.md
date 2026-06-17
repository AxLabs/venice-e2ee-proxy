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

### Run with npx (no clone, no build)

The proxy is published to npm as [`@axlabs/venice-e2ee-proxy`](https://www.npmjs.com/package/@axlabs/venice-e2ee-proxy) and exposes a `venice-e2ee-proxy` bin. Run the latest version without installing anything:

```bash
npx @axlabs/venice-e2ee-proxy --venice-api-key sk-... --port 3000
```

Configuration can come from **CLI flags**, **environment variables**, or a **`.env` file** in the current working directory. Precedence (highest first):

1. **CLI flags** (e.g. `--port 8080`)
2. **Environment variables** (e.g. `PORT=8080`)
3. **`.env` file**
4. **Built-in defaults**

```bash
# CLI only
npx @axlabs/venice-e2ee-proxy --venice-api-key sk-... --log-level debug

# Mix: API key from env, port from CLI
VENICE_API_KEY=sk-... npx @axlabs/venice-e2ee-proxy --port 8080

# .env in the current directory (CLI still wins when both are set)
echo "VENICE_API_KEY=sk-..." > .env
npx @axlabs/venice-e2ee-proxy --port 8080
```

To pin a specific version:

```bash
npx @axlabs/venice-e2ee-proxy@1.0.0 --venice-api-key sk-...
```

Or install globally:

```bash
npm install -g @axlabs/venice-e2ee-proxy
venice-e2ee-proxy --venice-api-key sk-... --port 3000
```

Show all options:

```bash
npx @axlabs/venice-e2ee-proxy --help
```

> **Requirements:** Node.js 20+ and `git` available on PATH. The proxy depends on the `venice-e2ee` library, which is fetched from GitHub during install, so the first `npx` run needs network access to npm **and** GitHub.

### Run from a clone (npx)

If you've cloned the repo, you can also run the local build directly:

```bash
npm run build
VENICE_API_KEY=sk-... npx .
```

---

## Configuration

Configuration is validated at startup — misconfiguration fails fast with a clear message.

**Precedence:** CLI flags → environment variables → `.env` file → defaults.

### CLI flags

All settings can be passed as CLI flags when running via `npx` or the `venice-e2ee-proxy` bin:

```bash
npx @axlabs/venice-e2ee-proxy \
  --venice-api-key sk-... \
  --port 8080 \
  --log-level debug \
  --no-verify-dcap
```

Run `npx @axlabs/venice-e2ee-proxy --help` for the full list.

| CLI flag | Env variable | Default | Description |
| -------- | ------------ | ------- | ----------- |
| `--venice-api-key <key>` | `VENICE_API_KEY` | — | Your Venice API key (**required**). |
| `-p`, `--port <port>` | `PORT` | `3000` | Port to listen on. |
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

Boolean flags accept `true`/`false`, `1`/`0`, `yes`/`no`, or `on`/`off` (same as env vars).

### Environment variables

The same settings can be provided via environment variables or a `.env` file in the working directory (useful for Docker, systemd, or local dev):

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
| `MAX_BODY_SIZE`      |          | `25mb`                  | Max request body size (any `bytes`-compatible value, e.g. `100kb`, `10mb`). Raise for large chat histories or base64 images. |
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

## Publishing (maintainers)

The package is published to npm as **`@axlabs/venice-e2ee-proxy`** (public scoped package).

What's already wired up:

- `bin` → `venice-e2ee-proxy` (the published binary; `dist/main.js` carries a `#!/usr/bin/env node` shebang).
- `files` whitelist → only `dist/`, `README.md`, `LICENSE`, and `.env.example` are published.
- `publishConfig.access: "public"` → the scoped package is published publicly.
- `prepublishOnly` → runs a fresh `npm run build` before publishing.

To cut a release:

```bash
# 1. Make sure you're authenticated and a member of the @axlabs org
npm login
npm whoami

# 2. Verify the contents that will be published (no source, no build cache)
npm pack --dry-run

# 3. Bump the version (creates a commit + git tag)
npm version patch   # or: minor | major

# 4. Publish (prepublishOnly rebuilds dist automatically)
npm publish

# 5. Push the version commit and tag
git push --follow-tags
```

> Smoke-test the tarball before publishing with `npm pack` then `VENICE_API_KEY=sk-... npx ./axlabs-venice-e2ee-proxy-<version>.tgz`.

---

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
