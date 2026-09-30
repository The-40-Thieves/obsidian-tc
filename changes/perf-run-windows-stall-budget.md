---
type: Changed
---
- **The perf-harness tests that run real collectors no longer time out on a stalled Windows CI
  runner.** `perf-run` (and the storage, runtime and harness collector tests) keep their tight
  budget on Linux and macOS and get a 60s ceiling on Windows, sized against the measured runner
  stalls rather than the steady-state cost; `perf-run` also skips the boot-probe subprocess, whose
  output it never asserts. Test-only: no runtime behaviour changes.
