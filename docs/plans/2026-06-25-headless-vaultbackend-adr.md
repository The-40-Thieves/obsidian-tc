# Headless VaultBackend ADR (THE-255) — lean v1

**Status:** Accepted (design locked at G2, trimmed at G3). Normal PR — G1 is closed.
**Branch:** `mislam2/the-255-obsidian-tc-headless-vaultbackend-full-vault-state`

## Context

turbovault runs filesystem-native and headless; cyanheads and obsidian-tc both require
Obsidian running. Headless is the one axis turbovault leads. Closing it brings obsidian-tc
to parity while keeping the live-app edge turbovault structurally cannot have, and erases
cyanheads' plugin setup-friction. Scope is **A + Tasks-query**: full vault-*state* headless;
action-firing tools degrade.

## Central decision (the reframe)

There is **one** `VaultBackend`, and it is the filesystem one. Reads and writes go through it
in both live and headless mode. "Live vs headless" is not a write-path distinction — it is
solely whether an app-action channel (the existing bridge / Local REST API client) is
reachable. The thing the ticket called `RestApiBackend` is **not** a peer CRUD backend; it is
conceptually an app-action dispatcher used only by tools that fire app behaviors. This removes
the parallel write path the ticket implied.

The enabler: M1 CRUD already writes direct-to-disk via `writeNoteAtomic`. The "writes must go
through REST to keep the index consistent" constraint was ARCHITECTURE.md drift. A running
Obsidian reconciles direct writes through its file watcher; a closed Obsidian has no index to
corrupt and rebuilds on next launch. Direct atomic writes are correct in both states.

## Locked decisions

- **D1 (G1, closed).** Live-mode write path is **Option A: unified direct-atomic-fs for both
  modes.** Not routed through the Local REST API plugin. One write path, one reindex trigger,
  safe whether Obsidian is open (watcher reconciles) or closed (nothing to corrupt). Accepted
  caveat: a file open in the live app with unsaved edits races the editor buffer
  (last-writer-wins, identical to any external editor or git).
- **D2.** No new dispatcher abstraction in v1. The existing bridge client already dispatches
  commands / QuickAdd / Templater / URI. THE-255 adds only `assertLive()` + the
  `requires_live_obsidian` error that Tier-3 tools raise before hitting the bridge headless.
- **D3.** Mode resolution is per-vault. Config `mode: live | headless | auto`; `auto` probes
  via `bridge/probe.ts` once at startup and caches; default `auto`. Explicit `live`/`headless`
  overrides the probe.
- **D4.** Index freshness via **index-on-write + boot-time reconcile** (G3 cut, replaces the
  always-on chokidar watcher). The server's own writes/deletes reindex the path inline
  (`indexer.indexNote`), in both modes — deterministic, no watcher race. A boot-time reconcile
  scan (`indexer.indexVault`, incremental by content hash) re-syncs files changed while the
  server was down. The live external-change watcher is deferred until a real need appears.
- **D5.** Error taxonomy: typed `requires_live_obsidian` (added additively to the shared
  `ErrorCode`, mapped to the MCP error channel) thrown by Tier-3 tools headless.
- **D6.** Tasks-query headless is a markdown checkbox scanner (status, text, `#tags`, file+line,
  basic due date). No Dataview dependency. Full Tasks-plugin emoji set deferred.
- **D7.** Tool partition: Tier-1 read and Tier-2 write vault-state are always available; Tier-3
  (action-firing, link-aware app ops, app-computed reads) is live-only.
- **D8 (G3).** v1 is decoupled from THE-219: runtime `requires_live_obsidian` degrade only. The
  "headless feeds THE-219 a default hidden set" integration waits until THE-219 merges.

## Degradation contract

**Always available (filesystem, both modes):** M1 CRUD (create/read/update/delete/append/
prepend, frontmatter), M3 format reads, walk/list, BM25 + sqlite-vec search (already
plugin-free), Tasks-query, multi-vault, ACL, audit.

**Live-only (returns `requires_live_obsidian` headless):** `execute_command`, `list_commands`,
QuickAdd macros, live Templater JS, `obsidian://` URI actions, link-aware rename/move, reads of
app-computed state (live Dataview/Bases results, rendered HTML).

## Lean v1 — what to build

`VaultBackend` (read/write/delete/exists/list/walk) + `FilesystemBackend` (wraps `notes-io` +
`paths`); `resolveMode` (live/headless/auto, probe-once-cached) + `assertLive` +
`requires_live_obsidian`; index-on-write + boot reconcile; Tasks-query scanner + tool; tools
wired to the backend with Tier-3 `assertLive` degrade; tests.

### Commit order (story order)

1. `docs/plans/2026-06-25-headless-vaultbackend-adr.md` (this).
2. `packages/shared/src/config.schema.ts` — per-vault `mode: live|headless|auto` (default auto).
3. `packages/server/src/vault/backend.ts` — `VaultBackend` (6 methods) + `FilesystemBackend`
   (wraps notes-io/paths), with an inline index-on-write seam on write/delete.
4. `packages/server/src/vault/mode.ts` — `resolveMode` (probe via bridge/probe.ts, cached) +
   `assertLive` + the `requires_live_obsidian` error (added additively to shared errors).
5. index-on-write wiring (mutations reindex via `indexer.indexNote`) + boot-time reconcile scan
   in `cli.ts` (`indexer.indexVault`, best-effort).
6. Tasks-query scanner + tool (markdown checkbox parse, no Dataview).
7. wire tools to the backend; Tier-3 tools call `assertLive` and degrade headless.
8. tests (unit: resolveMode precedence, FilesystemBackend CRUD on a temp vault, Tasks parse
   matrix, assertLive throws headless; integration: headless temp-vault end-to-end, boot
   reconcile picks up an out-of-band change).

## Deferred / out of scope (flagged)

- New `AppActionDispatcher` interface (the bridge client already dispatches).
- `chokidar` external-change watcher (index-on-write + boot reconcile cover v1).
- Filesystem link-rewriter for headless rename/move; `links_not_updated` soft-warning type.
- `readBytes` / `stat` backend methods (no in-scope caller — M3 formats read as text/JSON).
- THE-219 default-hidden integration (waits until THE-219 merges).
- Server-side Dataview-DQL / Templater evaluators; full Tasks-plugin emoji set.

Build only on proven headless-agent demand.
