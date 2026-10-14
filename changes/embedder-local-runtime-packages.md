---
type: Changed
---
- **npm installs only your platform's ONNX runtime.** `@the-40-thieves/obsidian-tc-embedder-local` now ships the bundled embedder and pulls the host's runtime from a per-platform optional package (`...-embedder-local-<os>-<arch>`), cutting the install from about 585 MB. Installs with `--omit=optional` lose the local embedder; use ollama or a hosted provider instead.
