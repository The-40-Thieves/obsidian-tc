---
type: Fixed
---
- **Intel Macs now get the local embedder through npm, `.mcpb`, and the standalone binary.** All three routes use ONNX Runtime Web WASM on macOS x64; embeddings match the native backend, with roughly 4x slower embedding in the measured two-text probe.
