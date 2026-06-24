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

See the [repo root README](../../README.md) for project overview.
