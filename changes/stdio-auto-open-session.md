---
type: Changed
config-schema-change: sessions.autoOpen
---
- **`sessions.autoOpen` now also opens a session on stdio.** It opens on the first tool call or resource read, and the server closes it at a clean exit. Off by default; if you already set it for HTTP, stdio now writes session rows and traces too, and `traceContent` defaults to true, so those traces include note bodies and search queries. (HTTP never closes an implicit session at exit; only the maintenance sweep does.) Tracked in GH #1457.
