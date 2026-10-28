---
type: Fixed
---
- **Followers report the leader's reconcile state.** Only the vault-lock leader runs reconciles, so a
  second MCP process on the same cache reported `reconcile: "pending"` and `notes_ready: false` for its
  whole life. The leader now persists its outcome to cache.db, and `server_health` and
  `get_index_status` on a follower read it back. Both outputs gain `reconcile_source`: `leader` on a
  follower (the leader's row, or pending until one lands), `self` on the leader. Nothing to configure.
