---
type: Security
---
- **`qs` 6.16.0 → 6.16.1 in the lockfile** (GHSA-6pq8-jhm2-2vcw: `qs.stringify` with `arrayFormat: 'comma'` threw an uncaught TypeError on array elements carrying a non-callable `toString`). Transitive only, through `express`/`body-parser` under the MCP SDK and `typed-rest-client` under Stryker; no obsidian-tc code calls `qs` directly. Nothing to do on upgrade.
