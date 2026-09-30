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

## Names a write refuses (every platform)

A vault syncs across operating systems, so a write that would **create** a Windows-hostile name
is refused with `path_invalid` everywhere: a `:` in any segment (on NTFS `report.md:.png` names
the `.png` alternate data stream of `report.md`), a trailing `.` or space (Win32 strips it, so
`a.md.` aliases `a.md`), and the reserved device names `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`,
`LPT1`-`LPT9` with any extension. Reads are not narrowed: a file that already exists under such
a name (synced from Linux, say) stays readable and can be updated in place; only creating,
moving or renaming **to** the name is refused.

Create-only writes (`overwrite: false`, `mode: create`, `create_canvas`, and the like) commit with
a no-replace rename, so a file another process creates between the existence check and the write
is never replaced: the loser gets `note_exists`. Linux uses `renameat2(RENAME_NOREPLACE)`, macOS
`RENAME_EXCL`; the pure-JS path (and Windows, where the native module has no safe-I/O) uses a hard
link then unlink. Parent directories are created one component at a time and a symlinked
component is refused, as is a symlinked `.trash`.

## Deferred: companion refresh nudge

An opt-in companion route that asks a live Obsidian to re-read an externally-modified file
(via the private `vault.adapter` reconcile surface) is designed but **deferred**: it relies on
another undocumented internal (see the companion README's private-API inventory) and cannot be
verified in CI (needs a live app). Tracked on THE-283.
