---
type: Changed
---
- **Intel macOS (x64) is now exercised in CI, not only Apple Silicon.** The native addon is built and run on `macos-15-intel` and `macos-26-intel`, and the server suite, install smoke and first-run matrix (npm, mcpb and the standalone binary) include both labels. An x64 Darwin regression now shows up on the pull request, not at release time.
