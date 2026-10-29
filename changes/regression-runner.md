---
type: Added
---
- **Run repository regression suites from one command.** `bun run test:regression` includes all six packages, Bun SQLite checks, tooling tests, both Python services, evaluation Python tests, documentation build and tool-page checks, lint, type checking, architecture boundaries, and model-fetch parity. It reports failed or blocked stages and continues independent suites. `bun run test:e2e` runs the real-runtime indexing lifecycle in both preparation modes.
