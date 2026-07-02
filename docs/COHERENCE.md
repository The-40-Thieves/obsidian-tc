# Live-Obsidian write coherence (THE-283)

obsidian-tc writes notes **direct-to-disk** (`writeNoteAtomic`: write to a `.tmp-<pid>-<ts>`
sibling, then a same-directory atomic rename). This is the correct substrate for a filesystem-
native server — but when the Obsidian **app is open on the same vault**, its external-change
watcher is imperfect and context-dependent. This page states the coherence contract honestly.

## The contract

1. **obsidian-tc is designed to be the vault's sole agent-facing writer.** With the LRA-MCP /
   mcp-tools bridges retired (see the cutover guide), there is no two-writers-no-lock hazard on
   the agent side: every agent write flows through obsidian-tc's ACL / HITL / CAS gates.
2. **The Obsidian app remains a concurrent human writer.** obsidian-tc's compare-and-swap
   (`prev_hash` on note writes, bookmarks/workspaces JSON edits, and `update_base`) is the
   defense: a stale agent write fails with `concurrent_modification` instead of clobbering a
   human edit.
3. **Agent writes can be invisible in an open Obsidian pane until refresh.** Obsidian's
   external-change detection generally picks up disk changes, but a note open in an active
   editor pane may not refresh until you navigate away and back, and detection degrades on
   OneDrive / network drives / some sandboxed installs (Obsidian forum #114185, #51660).
   **Recommendation:** prefer running agents against a vault Obsidian is not actively editing,
   or expect a manual reload of the open note after external writes.

## Windows: rename over an open file

`renameSync` on Windows maps to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`. It fails with
`EPERM` only if another process holds the target open **without** `FILE_SHARE_DELETE`. Obsidian
reads notes and closes the handle (it does not hold notes open), so the atomic replace succeeds
in practice; the residual risk is a **transient** `EPERM` if a write races the instant another
process (Obsidian indexing, an AV scanner) has the file open. obsidian-tc currently surfaces
that as the write error rather than retrying — deliberate, so failures are visible; a bounded
retry is a possible future hardening.

## Deferred: companion refresh nudge

An opt-in companion route that asks a live Obsidian to re-read an externally-modified file
(via the private `vault.adapter` reconcile surface) is designed but **deferred**: it relies on
another undocumented internal (see the companion README's private-API inventory) and cannot be
verified in CI (needs a live app). Tracked on THE-283.
