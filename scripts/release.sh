#!/usr/bin/env bash
#
# Release @axlabs/venice-e2ee-proxy to npm.
#
# This is a LOCAL release process — it is intentionally NOT run by GitHub
# Actions. It bumps the version, creates a git commit + annotated tag, pushes
# both to GitHub, and publishes to npm (so the proxy is runnable via `npx`).
#
# Usage:
#   ./scripts/release.sh <patch|minor|major|x.y.z>
#
# Examples:
#   ./scripts/release.sh patch     # 1.0.0 -> 1.0.1
#   ./scripts/release.sh minor     # 1.0.0 -> 1.1.0
#   ./scripts/release.sh 2.0.0     # explicit version
#
set -euo pipefail

BUMP="${1:-}"
if [ -z "$BUMP" ]; then
  echo "Usage: ./scripts/release.sh <patch|minor|major|x.y.z>" >&2
  exit 1
fi

RELEASE_BRANCH="main"

# ── Pre-flight checks ────────────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "$RELEASE_BRANCH" ]; then
  echo "Releases must be cut from '$RELEASE_BRANCH' (currently on '$BRANCH')." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash your changes first." >&2
  exit 1
fi

# Make sure local main is up to date with the remote.
git fetch --tags origin "$RELEASE_BRANCH"
if [ -n "$(git rev-list "HEAD..origin/$RELEASE_BRANCH")" ]; then
  echo "Local '$RELEASE_BRANCH' is behind 'origin/$RELEASE_BRANCH'. Pull first." >&2
  exit 1
fi

# Use the pinned Node version when nvm is available.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use
fi

# Must be authenticated to npm.
if ! npm whoami >/dev/null 2>&1; then
  echo "Not logged in to npm. Run 'npm login' (needs access to the @axlabs scope)." >&2
  exit 1
fi

# ── Verify, then build ───────────────────────────────────────────────────
npm ci
npm run lint
npm test
npm run build

# ── Bump version: creates a commit and an annotated tag vX.Y.Z ───────────
# For an explicit version that equals the current one (typical first release),
# `npm version` would error with "Version not changed". In that case we just
# tag the already-correct version instead of bumping it.
CURRENT_VERSION="$(node -p "require('./package.json').version")"
if [ "$BUMP" = "$CURRENT_VERSION" ]; then
  TAG="v${CURRENT_VERSION}"
  if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "package.json is already at $CURRENT_VERSION and tag $TAG already exists." >&2
    echo "Pick a new version (e.g. 'npm run release -- patch')." >&2
    exit 1
  fi
  echo "package.json is already at $CURRENT_VERSION; tagging current version without a bump."
  git tag -a "$TAG" -m "release: ${TAG}"
else
  npm version "$BUMP" -m "release: v%s"
  NEW_VERSION="$(node -p "require('./package.json').version")"
  TAG="v${NEW_VERSION}"
fi

# ── Push commit + tag to GitHub ──────────────────────────────────────────
git push origin "$RELEASE_BRANCH"
git push origin "$TAG"

# ── Publish to npm (scoped public; prepublishOnly re-runs the build) ──────
npm publish --access public

# ── Optional: create a GitHub Release for the tag, if gh is installed ─────
if command -v gh >/dev/null 2>&1; then
  gh release create "$TAG" --title "$TAG" --generate-notes || \
    echo "Note: 'gh release create' failed; the git tag '$TAG' is still pushed." >&2
fi

echo "Released ${TAG} ✓"
