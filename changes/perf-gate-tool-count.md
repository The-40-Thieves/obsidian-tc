---
type: Fixed
---
- **The post-merge `perf` job no longer fails on every tool addition.** `boot.tools_registered` was pinned in `baseline.small.json` with zero tolerance, so each new tool failed the gate (`172 vs baseline 171`) and commented on the tracking issue until the whole baseline was re-recorded. The gate now judges that key against `test/registered-tools.txt` minus the two inline-registered tools, still with exact equality, and the failure message names the manifest (#1024).
