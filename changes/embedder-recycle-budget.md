---
type: Changed
config-schema-change: embeddings.memoryBudgetMb
---
- **The child-process embedder is recycled at burst ends while the process is over budget.** With
  `embeddings.host` set to `child-process`, a finished index pass always drains the embedder child,
  and a drained index-on-write queue drains it while parent plus child RSS is over
  `embeddings.memoryBudgetMb`, at most once per 30 s per host. `server_health` reports the child as
  `memory.embedder_host` (state, restarts, rss_mb) and compares parent plus child RSS against the
  budget. The new counter `obsidian_tc_embedder_host_restarts_total{reason}` counts those drains.
  No setting changes; the in-process host is never recycled. Measured numbers for this change are
  not yet recorded.
