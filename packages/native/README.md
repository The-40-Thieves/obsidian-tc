# @the-40-thieves/obsidian-tc-native

Native perf module for obsidian-tc. Rust via [napi-rs](https://napi.rs) (v3).

As shipped it exposes three pure primitives, each with a numerically identical
pure-JS fallback so the server runs without a compiled binary:

- `cosineSimilarity` — cosine similarity between two equal-length `f64` vectors
- `tokenize` — Unicode (alphabetic + numeric) lowercase tokenizer
- `bm25Score` — BM25 term-scoring contribution

Reciprocal Rank Fusion and a `sqlite-vec` wrapper are deferred (sqlite-vec is loaded
as a SQLite extension at the TS/db layer). The earlier V2-reserved `kmeansAssign` /
`actrDecayScore` hooks were removed with the V2 ML scope.

Ships as cross-platform prebuilt binaries inside the npm package. **No Rust toolchain
required for end users.**

## Windows: locked `.node`

`build`/`build:debug` run through `scripts/build.mjs` rather than calling `napi build` directly.
napi's own post-build step copies the freshly linked `.node` into place, and on Windows that copy
can fail with a bare "Internal Error: Failed to copy artifact" (no errno, no path) when a running
process — an MCP client such as Claude Code, having `require()`d the addon via `dist/cli.js` —
still has the file open, even when the newly built bytes are identical to what's already there.
`build.mjs` builds into a private staging directory (a fresh one per invocation, so two concurrent
builds in one checkout never collide) and copies into place itself: identical bytes are skipped,
and a genuine lock fails with the real errno, the destination path, and a hint to stop the process
holding the file. See `scripts/lib/artifact-copy.mjs` for the copy decision, `scripts/lib/
napi-invocation.mjs` for how `napi build` is spawned (never through a shell — see that file's
header), `scripts/lib/stage-dir.mjs` for the per-invocation staging directory, and the matching
`test/*.test.ts` files (`bun run test:build-script`, no cargo/compiler needed).

**`--watch` is not supported through `bun run build`/`build:debug`.** This wrapper stages a build
and promotes it once, after `napi build` exits — incompatible with `napi build`'s own continuous
rebuild loop, which never exits on its own. Passing `--watch`/`-w` is rejected with a message
pointing at running `napi build --watch` (or `./node_modules/.bin/napi build --watch`) directly
from `packages/native` instead.

See the [repo root README](../../README.md) for project overview.
