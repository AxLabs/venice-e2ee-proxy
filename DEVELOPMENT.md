# Development & Release Guide

This document covers local development, continuous integration, and how to
publish `@axlabs/venice-e2ee-proxy` to
[npm](https://www.npmjs.com/package/@axlabs/venice-e2ee-proxy). The package is
published so the proxy can be run directly with `npx` — see the
[README](./README.md#quick-start).

## Prerequisites

- [nvm](https://github.com/nvm-sh/nvm) (the Node version is pinned in [`.nvmrc`](.nvmrc))
- An npm account that is a member of the [`@axlabs`](https://www.npmjs.com/org/axlabs) organization with publish rights
- Write access to the [`AxLabs/venice-e2ee-proxy`](https://github.com/AxLabs/venice-e2ee-proxy) repository
- Optionally, the [GitHub CLI](https://cli.github.com/) (`gh`) to auto-create GitHub Releases

## Local development

```bash
nvm use               # match the pinned Node version
npm ci                # clean, reproducible install from package-lock.json
npm run lint          # ESLint (flat config)
npm test              # run the test suite (Vitest)
npm run build         # TypeScript -> dist/ (nest build)
npm run start:dev     # run with hot reload
```

`dist/` is generated output and is **not** committed (see `.gitignore`); it is
produced fresh during the build and at publish time.

Configuration (API key, port, etc.) can be supplied via CLI flags, environment
variables, or a `.env` file — see [Configuration](./README.md#configuration).

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds, lints, and tests
the proxy on **every commit** (and on pull requests). It runs on **self-hosted
runners** (`runs-on: [self-hosted]`) and uses the Node version from `.nvmrc`.

CI does **not** publish or release. Releases are cut locally — see below.

## Publishing a release

Releases are **triggered locally**, not by GitHub Actions. The flow bumps the
version, commits it, creates an annotated git tag, pushes the commit and tag to
GitHub, and publishes the package to npm.

### One-time setup

```bash
npm login            # authenticate; must have access to the @axlabs scope
npm whoami           # verify you're logged in
```

The package is already configured for scoped public publishing via
`publishConfig.access = "public"` in `package.json`, so no extra flags are
required.

### Cut a release

From a clean `main` that is up to date with the remote:

```bash
# Pick the semver bump that matches the change set:
npm run release -- patch     # bug fixes:        1.0.0 -> 1.0.1
npm run release -- minor     # new features:     1.0.0 -> 1.1.0
npm run release -- major     # breaking changes: 1.0.0 -> 2.0.0

# Or release an explicit version:
npm run release -- 1.2.3
```

> You can also call the script directly: `./scripts/release.sh <bump>`.

> **First release / publishing the current version.** If `package.json` is already
> at the version you want to publish (e.g. the initial `1.0.0`), pass that exact
> version: `npm run release -- 1.0.0`. The script detects that the manifest is
> already at that version and **tags it without bumping** (a plain `npm version 1.0.0`
> would otherwise fail with `Version not changed`). After the first release, use
> `patch` / `minor` / `major` to bump normally.

### What the release script does

[`scripts/release.sh`](scripts/release.sh) performs, in order:

1. **Pre-flight checks** — refuses to run unless you are on `main`, the working
   tree is clean, and local `main` is not behind `origin/main`.
2. **Node + auth** — selects the pinned Node version (via nvm) and verifies you
   are logged in to npm.
3. **Verify & build** — runs `npm ci`, `npm run lint`, `npm test`, and `npm run build`.
4. **Version bump** — `npm version <bump>` updates `package.json`, creates a
   commit, and creates an annotated tag `vX.Y.Z`.
5. **Push** — `git push --follow-tags origin main` pushes the commit and the tag
   to GitHub (this is how the release is tagged on GitHub).
6. **Publish** — `npm publish --access public` (the `prepublishOnly` hook re-runs
   the build as a final guard).
7. **GitHub Release** *(optional)* — if `gh` is installed, creates a GitHub
   Release for the tag with auto-generated notes.

### Versioning

Follow [Semantic Versioning](https://semver.org/):

- **patch** — backward-compatible bug fixes
- **minor** — backward-compatible new functionality
- **major** — breaking changes

### Manual fallback

If you need to release without the script:

```bash
nvm use
npm ci && npm run lint && npm test && npm run build
npm version <patch|minor|major>     # creates commit + tag vX.Y.Z
git push --follow-tags origin main  # push commit + tag to GitHub
npm publish --access public
gh release create "v$(node -p "require('./package.json').version")" --generate-notes  # optional
```

### Verifying a release

```bash
npm view @axlabs/venice-e2ee-proxy version     # latest published version
git ls-remote --tags origin                    # tags pushed to GitHub

# Smoke-test the published package end to end:
VENICE_API_KEY=sk-... npx @axlabs/venice-e2ee-proxy --help
```

### Unpublishing / mistakes

npm restricts unpublishing. If you publish a broken version, prefer publishing a
new patch. Use `npm deprecate @axlabs/venice-e2ee-proxy@<version> "message"` to
warn consumers away from a bad release.
