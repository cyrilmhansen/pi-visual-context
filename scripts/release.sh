#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

font="$root/assets/fonts/romulus/Romulus.ttf"
if [[ ! -f "$font" ]]; then
  echo "release check: bundled Romulus font is missing: $font" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "release check: working tree is not clean; continuing without modifying it" >&2
fi

cargo test --manifest-path tools/rust-strip-lex/Cargo.toml
cargo test --manifest-path tools/c-strip-lex/Cargo.toml
cargo test --manifest-path tools/python-strip-lex/Cargo.toml
npm run build:rust
if node -e 'const p=require("./package.json"); process.exit(p.scripts?.test ? 0 : 1)' 2>/dev/null; then
  npm test
fi

# Non-inference smoke checks: validate extension loading and the local helper.
timeout 3 pi --no-extensions  --no-skills  --no-tools -e ./src/index.ts --no-session </dev/null >/tmp/pi-visual-context-smoke.out 2>/tmp/pi-visual-context-smoke.err || [[ $? -eq 124 ]]
cat /tmp/pi-visual-context-smoke.err

npm pack --dry-run
printf '\npackage version: '
node -p 'require("./package.json").version'
printf 'package contents above were produced by npm pack --dry-run\n'
