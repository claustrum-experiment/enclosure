#!/usr/bin/env bash
# Regenerate idl/claustrum_router.json from the program source without the Anchor CLI.
# (Same mechanism `anchor idl build` uses: Anchor's idl-build test hooks.)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROG="$ROOT/programs/claustrum-router"
PROGRAM_ID="${PROGRAM_ID:-$(grep -oP 'declare_id!\("\K[^"]+' "$PROG/src/lib.rs")}"
OUT="$(mktemp)"
( cd "$PROG" && ANCHOR_IDL_BUILD_PROGRAM_PATH="$PROG" RUSTFLAGS="--cfg procmacro2_semver_exempt" \
  cargo test --features idl-build --lib -- __anchor_private_print_idl --nocapture --test-threads=1 2>/dev/null > "$OUT" )
python3 "$ROOT/scripts/assemble-idl.py" "$OUT" "$PROGRAM_ID" > "$ROOT/idl/claustrum_router.json"
echo "wrote idl/claustrum_router.json for $PROGRAM_ID"
