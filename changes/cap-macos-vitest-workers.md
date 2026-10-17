---
type: Changed
---
- **CI: the server suite runs with two Vitest workers on `macos-latest`.** Those runners have 3 vCPUs, and three workers plus the main process competed with the runner agent. A new `VITEST_MAX_WORKERS` setting controls the cap; other CI runners and local runs keep their existing defaults.
