#!/usr/bin/env bash
# Local release: verify, build, smoke-test, publish to npm, tag.
#
#   ./scripts/release.sh            # publish the version in package.json
#   ./scripts/release.sh patch      # bump patch first (also: minor | major | 1.2.3)
#   DRY_RUN=1 ./scripts/release.sh  # do everything except publish/tag/push
set -euo pipefail
cd "$(dirname "$0")/.."

bump="${1:-}"
dry="${DRY_RUN:-}"
red() { printf '\033[31m%s\033[0m\n' "$*"; }
ok()  { printf '\033[32m%s\033[0m\n' "$*"; }
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# --- environment -------------------------------------------------------------
node_bin="$(command -v node || true)"
[ -n "$node_bin" ] || { red "node not on PATH"; exit 1; }
case "$node_bin" in
  /mnt/c/*|/mnt/[a-z]/*)
    red "node is the Windows build ($node_bin)."
    red "Publish with a Linux node, e.g.: export PATH=\"\$HOME/.nvm/versions/node/v24.20.0/bin:\$PATH\""
    exit 1;;
esac
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 18 ] || { red "node >= 18 required (have $(node -v))"; exit 1; }
command -v tmux >/dev/null || { red "tmux not installed — the smoke test needs it"; exit 1; }

# --- preconditions -----------------------------------------------------------
say "Checking git state"
[ -z "$(git status --porcelain)" ] || { red "working tree is dirty — commit or stash first"; git status --short; exit 1; }
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = main ] || red "warning: releasing from '$branch', not main"

say "Checking npm auth (registry.npmjs.org)"
who="$(npm whoami --registry https://registry.npmjs.org 2>/dev/null || true)"
[ -n "$who" ] || { red "not logged in — run: npm login --registry https://registry.npmjs.org"; exit 1; }
ok "npm user: $who"

# --- version -----------------------------------------------------------------
if [ -n "$bump" ]; then
  say "Bumping version ($bump)"
  npm version "$bump" --no-git-tag-version >/dev/null
fi
name="$(node -p 'require("./package.json").name')"
version="$(node -p 'require("./package.json").version')"
ok "$name@$version"

if npm view "$name@$version" version --registry https://registry.npmjs.org >/dev/null 2>&1; then
  red "$name@$version is already published — bump the version first"; exit 1
fi

# --- build & test ------------------------------------------------------------
say "Clean build"
npm run clean >/dev/null && npm run build

say "Smoke test (~60 s)"
node dist/test/smoke.js

say "Tarball contents"
npm pack --dry-run

# --- publish -----------------------------------------------------------------
if [ -n "$dry" ]; then ok "DRY_RUN set — stopping before publish"; exit 0; fi

say "Publishing"
npm publish

say "Tagging v$version"
git add package.json package-lock.json
git commit -m "Release v$version" --allow-empty
git tag -a "v$version" -m "v$version"
if git remote get-url origin >/dev/null 2>&1; then
  git push origin "$branch" --follow-tags || red "push failed — tag exists locally as v$version"
fi

ok "Published $name@$version — https://www.npmjs.com/package/$name"
