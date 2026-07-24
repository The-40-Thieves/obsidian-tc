# Durable Idempotency Claim State-Machine (THE-562 #13 / THE-413 residual) — Design

**Date:** 2026-07-24
**Ticket:** THE-562 audit item **#13** (the residual of THE-413, which is marked Done but only partially fixed).
**Status:** approved design → implementation plan next.

## Problem

`packages/server/src/mcp/registry.ts` dispatches every MCP tool call. When a call carries an
idempotency key, the pipeline atomically claims a slot in `idempotency_keys`, runs the handler,
then finalizes (records the response) or, on failure, **deletes** the claim so the slot is free.

The handler's external side effect — a vault-note file write (`commit_capture`), a DB row +
note re-materialize (`add_observation`/`link_entities`), a periodic-note append, a `bulk-tools`
mutation — commits **inside** the handler (`registry.ts:935`). Several failure points sit
**after** the handler returns but before the response is finalized:

1. **Strict-output-schema violation** (`registry.ts:958-962`) — `strictOutputSchema` is on by
   default under test/CI and opt-in in prod; a handler whose own successful output fails its
   advertised `outputSchema` throws `internal_error` *after* committing.
2. **`JSON.stringify(out ?? null)`** (`registry.ts:966`) — a circular reference or `BigInt` in the
   payload throws *after* the effect committed.
3. **Overflow-finalize fault** (`registry.ts:982-991`) — THE-413 changed the overflow path to
   *finalize* (not delete) so a retry replays the "too big" error; but if that finalize UPDATE
   itself faults, the claim stays in-flight and is reclaimable — the documented residual.

All three land in the generic catch at `registry.ts:1030-1037`, which **unconditionally deletes
the claim**. A retry with the same key then re-enters, re-claims, and **re-runs the handler —
double-committing the external effect.** No test today exercises "handler committed, then
something downstream threw."

Additionally, a hard **process crash** between the effect and the finalize leaves the row
`completed_at IS NULL`; the reclaim predicate at `registry.ts:754-758` treats any such row past
the reclaim window as reclaimable, deletes it, and re-runs — the same double-effect, via crash
rather than a caught throw.

This is item **#13**: *"a durable ambiguous post-effect state is still needed for genuine
at-most-once."*

## Goal

Make a post-effect failure record a **durable "this may have run" outcome** instead of deleting
the claim, so a retry receives a definite answer (`indeterminate_outcome`) rather than a second
execution — covering both the in-process post-effect throws **and** the crash-after-effect window.
This is Approach **B** (durable state machine, chosen over the cheaper in-memory-only Approach A).

## Design

### 1. Explicit state column (new migration)

Add an explicit `state` column to `idempotency_keys`, making the implicit state machine real. The
THE-413 states (claimed → executing → effect_committed → response_recorded → unknown) collapse to
four persisted values:

| `state` | `completed_at` | meaning | retry / reclaim response |
|---|---|---|---|
| `in_flight` | NULL | claimed; handler not confirmed returned | concurrent → `idempotency_in_flight`; past reclaim window → **reclaim & re-run** (never committed) |
| `effect_committed` | NULL | handler returned; effect may be durable, response not recorded | **never re-run**; within TTL → `indeterminate_outcome`; past TTL → GC (bounded) |
| `completed` | set | response (or overflow sentinel) recorded | replay cached result / overflow error (unchanged) |
| `indeterminate` | set | post-effect fault finalized it | `indeterminate_outcome` |

**Migration** (`packages/server/src/migrations/`, new file appended to the chain, registered in
`db/migration-manifest.ts` — the #9 completeness gate is exactly the mechanism that guards this):

```sql
ALTER TABLE idempotency_keys ADD COLUMN state TEXT NOT NULL DEFAULT 'in_flight';
UPDATE idempotency_keys SET state = 'completed' WHERE completed_at IS NOT NULL;
```

`ADD COLUMN ... NOT NULL DEFAULT '<const>'` is legal in SQLite. Pre-existing in-flight rows stay
`in_flight` (old reclaim behavior — acceptable; they are near-expiry anyway).

### 2. Dispatch flow changes (`registry.ts`)

**a. Durable effect marker — right after the handler returns.** Inside the `runAudited` callback,
immediately after `const r = await def.handler(parsed.data, ctx)` (`:935`), set an in-memory
`handlerReturned = true` **and** durably `UPDATE ... SET state = 'effect_committed'` for the
claimed key. This single write is what closes the crash window: a crash after this point leaves a
durable `effect_committed` marker that reclaim honors.

- In-memory `handlerReturned` drives the **catch** decision (in-process faults).
- Durable `state = 'effect_committed'` drives the **reclaim** decision (crash faults).
- Both are needed; the marker write itself faulting is covered because `handlerReturned` is set
  independently of it.

**b. `finalizeIdempotency` also sets `state = 'completed'`.** The one helper (used by both the
success finalize at `:1014-1015` and the overflow finalize at `:982`) transitions the row to
`completed` in the same UPDATE. Overflow's sentinel (`result="null"`, oversized `result_size`) is
unchanged, so the existing overflow-replay re-check at `:786` still fires.

**c. New `finalizeIndeterminate` helper.** `UPDATE ... SET state='indeterminate', completed_at=?,
result='null', result_size=NULL`. `result_size=NULL` deliberately avoids the overflow re-check
(`:786` requires `result_size > maxResponseBytes`); the `state='indeterminate'` branch fires first.

**d. Catch (`:1030-1037`) — the bug site.** Replace the unconditional delete with:
```
if (idemClaimed && idemKey) {
  if (handlerReturned) {
    // post-effect fault: NEVER delete — record indeterminate so a retry gets a definite answer
    try { this.finalizeIndeterminate(ctx.db, ctx.vaultId, idemKey, now()); }
    catch (finErr) { try { this.onInternalError?.(`idempotency_indeterminate:${name}`, ctx.vaultId, finErr); } catch {} }
  } else {
    try { this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey); } catch {}  // pre-effect: safe reclaim
  }
}
```
Pre-handler failures (ACL throw, handler throws before any effect) still delete → the slot frees
and a legitimate retry re-runs. Only a *post-handler* fault records indeterminate.

**e. Reclaim predicate (`:754-758`) — exclude `effect_committed`.** The in-flight-crash reclaim
branch must fire only for `state='in_flight'`:
```
if (row && (row.expires_at <= now()
    || (row.state === 'in_flight' && row.completed_at == null && row.started_at + this.idempotencyReclaimMs <= now()))) {
  // reclaim & re-run
}
```
TTL expiry (`expires_at <= now()`) still GCs any state — at-most-once remains bounded by the TTL,
as today. An `effect_committed` orphan within TTL falls through to the replay block.

**f. Replay block (`:769-838`) — two new branches, before the `completed_at` check.**
```
if (!row) throw idempotency_in_flight
if (mismatch) throw idempotency_key_mismatch
if (row.state === 'indeterminate') return indeterminateResponse(idemKey)   // NEW
if (row.state === 'effect_committed') return indeterminateResponse(idemKey) // NEW (crash orphan within TTL)
if (row.completed_at != null) { ...overflow re-check / cached result... }   // unchanged
throw idempotency_in_flight  // still genuinely in_flight (concurrent)
```

### 3. The retry contract — `indeterminate_outcome`

Because the effect committed but no response was ever recorded, the real result cannot be
reconstructed. A retry against an `indeterminate`/`effect_committed`-orphan row returns a
structured error (mirroring the `overflow` replay's response shape — an `ok:false` with a typed
`ObsidianTcError`), **not** a re-execution:

- code: `indeterminate_outcome`
- message: *"a prior attempt with this idempotency key may have applied its effect but did not
  record a result; verify state before retrying"*
- data: `{ key }`

This is the honest guarantee at-most-once buys for a non-transactional external effect: never run
twice; on ambiguity, report ambiguity. Metered as an idempotency hit (reuse `incIdempotencyHit`).

### 4. Scope stance

Any keyed handler that returns is treated as "effect may be committed." Idempotency keys are
attached to mutating tools only (`commit_capture`, `add_observation`/`link_entities`,
`append_to_period`, `bulk-tools`), so this is accurate. If any effect-free tool ever carries a
key, the worst case is a *blocked harmless retry* (an `indeterminate_outcome` where a re-run would
have been safe) — never a double-effect. The implementation will confirm the keyed-tool set and
note it; no per-tool effect declaration is introduced (YAGNI).

> **Correction (THE-572).** The keyed-tool set named above was never confirmed against the
> schemas, and three of its members are wrong. `extractIdempotencyKey` (`registry.ts`) reads a
> top-level `idempotency_key`, the `bulk_idempotency_key` alias, or a nested
> `options.idempotency_key`. The tools whose input schema actually declares one are:
> **`add_observation`**, **`enqueue_capture`**, **`start_session`**, **`create_periodic_note`**,
> **`append_to_periodic_note`**, **`bulk_create_notes`** (via the alias) and **`bulk_move_notes`**.
> `commit_capture`, `link_entities` and `bulk_set_property` are **not** keyed and never entered
> this pipeline. The scope stance itself is unaffected — every genuinely keyed tool is mutating —
> but the worked examples in this document should be read against that list.

## Testing — fault injection at each post-effect boundary

New `idempotency-post-effect.test.ts` (or extend `idempotency.test.ts`). Each uses a handler that
commits an **observable** effect (increments a counter / writes a sentinel row) so a double-run is
detectable:

1. **Post-effect schema-strict throw:** handler commits, returns output violating `outputSchema`,
   `strictOutputSchema=true`. Assert: handler ran once; claim not deleted; `row.state='indeterminate'`;
   retry returns `indeterminate_outcome` and the effect counter stays 1.
2. **Post-effect `JSON.stringify` throw:** handler commits, returns a value with a `BigInt`/circular
   ref. Same assertions.
3. **Overflow-finalize fault:** handler commits, output > `maxResponseBytes`, and the finalize
   UPDATE is made to throw (db stub / read-only). Assert the durable marker was `effect_committed`
   *before* finalize, so a subsequent retry returns `indeterminate_outcome` (not a re-run) — closes
   the documented THE-413 residual.
4. **Simulated crash after effect:** drive dispatch to set `state='effect_committed'` then skip
   finalize (simulate death). A later dispatch with the same key, past the reclaim window but within
   TTL, returns `indeterminate_outcome` and does **not** re-run the handler. Past TTL: GC'd + re-runnable.
5. **Pre-handler failure still reclaims (no regression):** a failure before the handler runs (or a
   handler that throws with no effect) deletes the claim; a retry re-runs. (Existing
   `idempotency.test.ts:153-173` stays green.)
6. **Success replay + overflow replay unchanged** (existing tests stay green).

## Irreducible residual (documented, not fixed)

The microsecond between the handler's external filesystem write and the `effect_committed` UPDATE
is the two-generals limit: unclosable without co-transactional effects (Approach C — rearchitecting
every writer, out of scope). A crash *exactly* in that window still leaves `state='in_flight'` and
is reclaimable. This is strictly narrower than today's window (which spans the entire
handler-return → finalize interval) and is documented in the code comment + CHANGELOG.

## Files

- **Modify** `packages/server/src/mcp/registry.ts` — marker write after handler; `finalizeIdempotency`
  sets `state='completed'`; new `finalizeIndeterminate`; catch records indeterminate vs delete;
  reclaim excludes `effect_committed`; replay adds `indeterminate`/`effect_committed` branches;
  read helper selects `state`; `indeterminateResponse` helper.
- **Create** `packages/server/src/migrations/<NNN>_idempotency_state.sql` — the `state` column +
  backfill.
- **Modify** `packages/server/src/db/migration-manifest.ts` — register the new migration (#9 gate).
- **Test** `packages/server/test/idempotency-post-effect.test.ts` (new) + keep `idempotency.test.ts`
  green.
- **Modify** `CHANGELOG.md` — a `### Changed`/`### Fixed` entry (at-most-once under post-effect faults).

## Global constraints

- DCO-signed commits (`git commit -s`), trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- The new migration is **additive** (a brand-new file); do NOT edit any applied migration
  (checksum-verified). It MUST be registered in the manifest or the #9 CI bijection test fails.
- Verification before any push: root `bun run typecheck`, `bun run lint`, full server suite
  (`cd packages/server && bun run test`), `node scripts/check-boundaries.mjs`.
- Public repo: no secrets/vault data in code or tests.
