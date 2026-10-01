---
type: Changed
---
- **`retrieval.cache` measured on a real vault; it stays off.** A cache hit answers a repeated `vault_graph_search` in about 1 to 4 ms against about 850 ms without the cache, `results` is byte-identical to the cache-off response across two callers' ACLs and a generation bump, and the cache holds about 12.5 MiB at the default `maxEntries`. The default stays `false` because a hit omits `coverage` from the `vault_graph_search` response, and the live store shows no repeat traffic to save. The measurement harness is `eval/query-cache.ts` (see `docs/design/search-indexing-and-cache.md`); the config comment records the numbers.
