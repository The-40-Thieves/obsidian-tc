---
type: Changed
config-schema-change: embeddings.memoryBudgetMb
---
- **The child-process embedder is recycled at burst ends while parent plus child RSS is over the budget.** With
  `embeddings.host` set to `child-process` (GH #1433), a finished index pass that embedded chunks drains the
  embedder child, and a drained index-on-write queue drains it while parent plus child RSS is over
  `embeddings.memoryBudgetMb` and the parent alone is under it, at most once per 30 s per host. `server_health`
  reports the child as `memory.embedder_host` (state, restarts, rss_mb). The counter
  `obsidian_tc_embedder_host_recycles_total{reason}` counts those recycles. No setting changes; the in-process
  host is never recycled. Measured on a 300-note vault with a full reconcile and 20 write bursts: total RSS
  after the 20th burst was 583 MB (parent 81 + child 502) with recycling against 1084 MB in-process, with
  0 crash restarts and 3 policy recycles (1 reconcile, 2 budget).
