# @the-40-thieves/obsidian-tc-native

Native perf module for obsidian-tc. Rust via [napi-rs](https://napi.rs).

Handles perf-critical primitives that would be too slow in JavaScript:

- Vector similarity (cosine, dot product)
- Reciprocal Rank Fusion
- BM25 scoring
- Tokenization
- `sqlite-vec` extension wrapper
- ~~K-means clustering, ACT-R decay scoring~~ *(deprecated — reserved for an out-of-scope intelligence layer; `kmeansAssign` / `actrDecayScore` are being removed)*

Ships as cross-platform prebuilt binaries inside the npm package. **No Rust toolchain required for end users.**

See the [repo root README](../../README.md) for project overview.
