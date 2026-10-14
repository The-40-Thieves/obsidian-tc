---
type: Fixed
---
- **The performance gate again measures only index batching transactions.** Runtime-provisioned search schemas are set up before transaction counting starts, so a cold perf run no longer reports their three `BEGIN IMMEDIATE` transactions as an indexing regression. Refs #1256
