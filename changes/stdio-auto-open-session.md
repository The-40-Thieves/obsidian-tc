---
type: Changed
config-schema-change: sessions.autoOpen
---
- **`sessions.autoOpen` now also opens a session on stdio.** It opens on the first tool call or resource read, and the server closes it at a clean exit, as it already did over HTTP. Off by default, so nothing changes until you set it. Tracked in GH #1457.
