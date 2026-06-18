# NOTICE

Venice E2EE Proxy (`@axlabs/venice-e2ee-proxy`)
Copyright © AxLabs.

This product is licensed under the Apache License, Version 2.0 (the
"License"). You may obtain a copy of the License in [`LICENSE`](./LICENSE) or at
<http://www.apache.org/licenses/LICENSE-2.0>.

---

## ⚠️ Important: GPL-3.0 dependency

This project depends on **[`@axlabs/venice-e2ee`](https://github.com/AxLabs/venice-e2ee)**,
which is licensed under **GPL-3.0-only**. The proxy itself is Apache-2.0, but the
combined/distributed work links against a GPL-3.0 library at runtime.

What this means in practice:

- **Running the proxy yourself** (internally, or as a hosted service users only
  interact with over the network) does **not** trigger GPL distribution
  obligations. The GPL is not the AGPL — network use is not "distribution."
- **Distributing the proxy** (e.g. shipping a binary/bundle, a Docker image, or
  any artifact that includes or installs `@axlabs/venice-e2ee`) means the
  combined work is subject to the **GPL-3.0** terms: you must make the
  corresponding source available and license the combined work under GPL-3.0.
- The proxy's own source remains available under Apache-2.0; the GPL obligation
  comes from the bundled/linked dependency, not from this repository's license.

If a GPL-encumbered distribution is not acceptable for your use case, replace or
re-license the `@axlabs/venice-e2ee` dependency before distributing.

> This NOTICE is informational and is **not legal advice**. Consult counsel for
> your specific distribution scenario.

---

## Third-party dependencies

This software includes, or depends on, the following third-party packages. Each
is the property of its respective authors and is used under its own license.

### Runtime dependencies (direct)

| Package | License | Project |
| ------- | ------- | ------- |
| `@axlabs/venice-e2ee` | **GPL-3.0-only** | <https://github.com/AxLabs/venice-e2ee> |
| `@phala/dcap-qvl` | Apache-2.0 | <https://github.com/Phala-Network/dcap-qvl> |
| `@nestjs/common` | MIT | <https://github.com/nestjs/nest> |
| `@nestjs/config` | MIT | <https://github.com/nestjs/config> |
| `@nestjs/core` | MIT | <https://github.com/nestjs/nest> |
| `@nestjs/platform-express` | MIT | <https://github.com/nestjs/nest> |
| `@nestjs/swagger` | MIT | <https://github.com/nestjs/swagger> |
| `class-transformer` | MIT | <https://github.com/typestack/class-transformer> |
| `class-validator` | MIT | <https://github.com/typestack/class-validator> |
| `reflect-metadata` | Apache-2.0 | <https://github.com/rbuckton/reflect-metadata> |
| `rxjs` | Apache-2.0 | <https://github.com/ReactiveX/rxjs> |

### Notable transitive dependencies

Pulled in by `@axlabs/venice-e2ee` for the core cryptography:

| Package | License | Project |
| ------- | ------- | ------- |
| `@noble/secp256k1` | MIT | <https://github.com/paulmillr/noble-secp256k1> |
| `@noble/hashes` | MIT | <https://github.com/paulmillr/noble-hashes> |

For the complete, resolved dependency tree and their licenses, see
`package-lock.json` or run `npm ls` / a license scanner such as
`npx license-checker --summary`.
