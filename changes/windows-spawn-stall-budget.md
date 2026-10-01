---
type: Changed
---
- **Tests that spawn a child process no longer fail on a stalled Windows CI runner.** The one
  Windows stall ceiling the perf-harness tests already used (`test/stall-timeouts.ts`, formerly
  `perf-timeouts.ts`) now also sets the child kill timeouts, readiness timers and per-test timeouts
  of every spawn-based test, and vitest's Windows per-test floor (15s, below a measured 20s stall
  that killed `memory-import-cli` with exit -1) is the same value. Linux and macOS budgets are
  unchanged. `memory import`'s missing-flag cases now run in-process, with one real spawn left as
  the smoke test, and a source-scan test fails any spawn test that reintroduces a tight literal
  budget. Test-only: no runtime behaviour changes (#1069).
