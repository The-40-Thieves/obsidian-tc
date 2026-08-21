# Context bundle export/import

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## Why a CLI command, not an MCP tool (THE-636)

`context-export`/`context-import` are CLI-only (`cli/commands/context-export.ts`,
`context-import.ts`), never dispatched through `registry.dispatch` or exposed as an MCP tool. The
MCP surface is itself the exfiltration/attack-surface concern item 2 of the originating ticket warns
about — a tool an agent could invoke would turn bulk export of the derived plane into something
reachable from inside a session. `forget.ts` already established the precedent this follows:
admin/operator-only, filesystem-touching commands that read or write the experiential store directly,
outside the dispatch path.

## "Forget wins over import" has two directions (ticket item 3; THE-239/THE-605/THE-609's audit story)

**(a) Imported-forgotten stays forgotten.** `agent_episodes` rows are only ever exported with
`blocked = 0` (`context-bundle-schema.ts` hard-pins `blocked: z.literal(0)` on the row schema) — a
tombstoned episode never leaves the source install in the first place. The harder case is the
*receiving* install: it may have forgotten an episode the bundle still carries as live, because a
different install forgot it independently, at any time — before or after the bundle's
`exported_at`. `importContextBundle` reconciles against the **target's own** `forget_log` before
inserting any `agent_episodes` row (never against the bundle's), and the check is existence-only,
with no timestamp comparison.

An earlier version gated on `forget_log.ts >= bundle.exported_at`, reasoning "only a forget that
happened *after* this bundle was made can be resurrecting something new." That reasoning is wrong
across machines with independent clocks and independent forget histories. The primary migration case
is a bundle exported *now* from install A, carrying an episode that install B (the target) forgot
*long ago* (`ts < exported_at`). Under the timestamp-gated check that forget is invisible — its `ts`
is always less than `exported_at` — and the episode gets re-written, unblocked, resurrecting exactly
what B tombstoned. Wall-clock comparison across machines is not a safety primitive here: if the
target's `forget_log` names a target id at all, that id is never resurrected by import, full stop,
regardless of when the forget happened.

**(b) Imported `forget_log` entries apply to target content.** A `forget_log` entry is audit history,
not inert metadata — importing one must have the same real effect appending it locally would have.
So `forget_log` rows import first (before `agent_episodes`), and each new `'episode'`-kind entry
immediately blocks (and, for `'erase'`, scrubs) any matching episode already in the target — whether
that episode is native to the target or arrived via a different, earlier import. A forget event
travelling in the bundle must be able to retroactively forget content the bundle itself never
carried.

## Cross-install vault identity (THE-636 review fix, BLOCKER 2)

A vault id is a bare operator label (`"main"` everywhere, in practice) with no cross-install
identity, and `vault_object_state.object_id` / `chunk_retrievals.chunk_id` are
`chunkId(vaultId, path, index)` — a hash of that same label, not of anything globally unique. Two
unrelated installs each running a vault called `"main"` produce identical chunk ids for same-path
notes. Importing verbatim would silently merge two unrelated vaults' derived state under a shared
label. Two mechanisms close this:

- `remapBundleVault` makes `--vault` load-bearing: when the operator names a target vault, every
  vault-scoped row (the 6 tables that carry `vault_id`) is remapped from the bundle's actual source
  vault to that target, and a bundle whose vault-scoped rows name more than one source vault is
  refused outright — "the" source vault would be undefined. Omitting `--vault` keeps rows verbatim,
  which is the other legitimate case the ticket names: migrating a whole deployment to a new
  machine, where source and target are the *same* logical vault under the *same* id, not two vaults
  merging.
- `chunk_retrievals`/`vault_object_state` have no `vault_id` column at all, so there is nothing to
  remap. Instead, `importContextBundle` verifies each row's chunk id ground-truth against the
  target's own `cache.db` `chunks` table: a row whose id the target has never indexed is not
  imported (`skipped_unmatched`), because there is no local evidence it belongs to a vault this
  install actually has. This is best-effort and index-dependent — importing before the target vault
  has been indexed matches nothing; re-running the import after `index_vault`/`obsidian-tc index`
  picks up what an earlier pass skipped, since idempotent dedup means a re-run costs nothing.

## Idempotency

Every table dedups on a natural key before writing — never "insert and see if it throws" against
autoincrement. Re-importing the same bundle a second time writes nothing new anywhere. See
`importDeduped`'s doc comment in `context-bundle.ts` for the per-table key list.
