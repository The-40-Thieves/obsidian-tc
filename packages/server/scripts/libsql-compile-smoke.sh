#!/usr/bin/env bash
# Proves the libsql native addon survives `bun build --compile`: compiles an entry that opens a
# database through the libsql adapter, then runs the binary from a directory with no node_modules
# and asserts SQLite 3.45, an FTS5 query and vec_version. Needs network (the host target's addon and
# sqlite-vec are fetched from the registry, integrity-verified). Run from anywhere.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work="$(mktemp -d)"
vec_file="packages/server/src/search/vec-embedded.ts"
cleanup() {
  # vec-embedded.ts is a per-build artifact whose committed value is the empty placeholder.
  (cd "$root" && git checkout -- "$vec_file") || true
  rm -rf "$work"
}
trap cleanup EXIT

cd "$root"
node scripts/gen-embedded-vec.mjs
bytes=$(wc -c < "$vec_file")
[ "$bytes" -gt 100000 ] || { echo "vec-embedded.ts is $bytes bytes: nothing was embedded" >&2; exit 1; }

bun packages/server/scripts/libsql-compile-smoke-build.ts "$work/smoke-bin"

# A directory with no node_modules, and a copy of the binary, so nothing can resolve from the repo.
mkdir "$work/run"
cp "$work/smoke-bin" "$work/run/smoke-bin"
out="$(cd "$work/run" && ./smoke-bin)"
echo "$out"
case "$out" in
  *"sqlite=3.45."*"fts5=1"*"vec_version=v"*) echo "libsql-compile-smoke: PASS" ;;
  *) echo "libsql-compile-smoke: FAIL (unexpected output)" >&2; exit 1 ;;
esac
