---
type: Fixed
---
- **`lint_wiki` and the scheduled wiki lint no longer hold the event loop for a whole-vault scan.** Their orphan, dangling-link, missing-sources and contradiction scans now hand the loop back every few milliseconds, so a timer, a concurrent tool call or a shutdown signal is serviced mid-lint, and a cancelled `lint_wiki` call (or a shutdown during the scheduled lint) stops within one slice. The report is byte-for-byte what it was. The index reconcile's per-note yield now uses the same time slice as the scan tools instead of a separate every-64-notes counter; it still takes no forced turn when the caller passes no abort signal.
