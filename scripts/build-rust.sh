#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cargo build --release --manifest-path "$root/tools/rust-strip-lex/Cargo.toml"
cargo build --release --manifest-path "$root/tools/c-strip-lex/Cargo.toml"
