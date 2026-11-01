---
type: Added
config-schema-change: embeddings.memoryBudgetMb
---
- **The server now reports its own process memory.** `/metrics` exposes `obsidian_tc_process_memory_bytes` by `kind` (`rss`, `heap_used`, `external`, `array_buffers`), read at scrape time, and `server_health` returns a `memory` block (`rss_mb`, `external_mb`, `budget_mb`, `over_budget`). A long-lived server that climbs with only host-wide lag as its symptom (#1433) can now be seen directly. Set the optional `embeddings.memoryBudgetMb` to have `server_health` report `over_budget: true` while the process RSS is above it; unset, no budget applies.
