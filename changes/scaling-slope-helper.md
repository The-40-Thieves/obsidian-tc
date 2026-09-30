---
type: Changed
---
- **Tests: the "must not go quadratic" checks share one multi-size slope assertion instead of single time ratios.** `packages/server/test/scaling.ts` (`expectLinear`) times four input sizes, fits the log-log slope of best-of-N CPU time (wall clock on Windows) and fails above 1.6; the link-scan and redaction-scanner DoS tests use it, which removes the two-point ratio that bounced merges on a noisy runner. Test-only, no runtime change (#1064).
