---
type: Fixed
---
- **`server_health` no longer reads a respawned embedder child's memory as zero.** After the child-process embedder respawned, its RSS stayed unknown until the next index burst, so `memory.over_budget` counted the parent alone and reported `false` while the child could hold hundreds of MB. The child's RSS is now requested as soon as it reports ready. While it is still unknown, `memory.over_budget` is `null` and `memory.embedder_host` carries `child_rss_known: false`. See GitHub issue 1433.
