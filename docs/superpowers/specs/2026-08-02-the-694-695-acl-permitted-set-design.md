# An ACL predicate SQLite can see

**Date:** 2026-08-02
**Status:** design approved, not yet implemented
**Tickets:** THE-694 (router timing residual), THE-695 (graph-walk bridges, BM25 over-fetch boundary), THE-693 (hub defence, shares the eval)
**Scope:** `packages/server/src/migrations` (new), `packages/server/src/search/acl_path_set.ts` (new), `search/router.ts`, `search/chunk_fts.ts`, `search/graph_expand.ts`, `search/graph_search_stages/graph_expansion.ts`

## Goal

Three retrieval paths compute an aggregate over the whole corpus and hand the result to a caller
who can only see part of it. Closing that needs the authorization boundary to be **visible to
SQLite**, which the current architecture does not provide. This design provides it once and uses it
in the places it actually helps.

It also **retires one of the two things the tickets asked for**, on measured evidence. See
"What the measurement changed".

## Non-goals

- Unifying every ACL check in the codebase. Only the three aggregate paths above are in scope.
- Changing the read contract of any tool. No tool returns content it did not return before.
- Closing the timing channel for the dense arm. THE-287 already pushed that filter into SQL.

## What the measurement changed

THE-694 proposes a materialized permitted set so the router's readable-df count "never leaves SQL —
so denied rows are never examined in JS." Both halves of that are true. Neither closes the ticket.

Built on a live snapshot with a restricted ACL, running the ticket's own guardrail — is a term
present *only* in denied notes distinguishable from an absent one? Both return `0`:

| term | hidden matches | readable | mean | median | CV |
| --- | --- | --- | --- | --- | --- |
| `audit` (hidden-only) | 1,504 | 0 | **3.381 ms** | 3.155 ms | 0.16 |
| `zzqqxx…` (absent) | 0 | 0 | **0.047 ms** | 0.041 ms | 0.25 |

**72x on means, 77x on medians, and the distributions do not overlap** — the closest observations
are 38x apart. The plan explains it:

```
QUERY PLAN
|--SCAN chunk_fts VIRTUAL TABLE INDEX 0:M4
`--SEARCH a USING PRIMARY KEY (set_id=? AND path=?)
```

SQLite iterates the whole match list and probes membership per row, so work stays proportional to
**total** matches, not readable ones. Moving the scan from JS into SQLite makes it faster and
lower-variance — if anything easier to exploit.

So the permitted set is the right substrate for THE-695 and the wrong tool for THE-694. THE-694 is
closed instead by **not asking the question**: when `readEnumerationUnrestricted(acl)` is false,
skip rare-term classification entirely and take `standard` routing. No query is issued, so there is
nothing to time. The cost is that restricted callers lose a ranking optimization, not correctness.
Unrestricted callers are unaffected — their `COUNT(*)` is already exact and reveals nothing they
cannot already read.

## Schema

Two tables, appended to `CACHE_MIGRATION_FILES` as `20260802_001_acl_path_sets.sql`.

```sql
CREATE TABLE IF NOT EXISTS acl_path_sets (
  set_id          INTEGER PRIMARY KEY,      -- surrogate; rowid table, deliberately
  acl_fingerprint TEXT    NOT NULL,
  vault_id        TEXT    NOT NULL,
  generation      INTEGER NOT NULL,
  built_at        INTEGER NOT NULL,         -- LRU key
  path_count      INTEGER NOT NULL,         -- non-empty floor
  UNIQUE (acl_fingerprint, vault_id)
);

CREATE TABLE IF NOT EXISTS acl_path_members (
  set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE,
  path   TEXT    NOT NULL,
  PRIMARY KEY (set_id, path)
) WITHOUT ROWID;
```

**Path-keyed, not chunk-keyed.** `readableRel` is a pure function of the path, so the set holds
1,146 rows rather than 13,486 — 11.77x smaller — and still serves all three consumers (`chunks`
join `path`, `vault_edges` join `source_path`/`target_path`, `notes` join `path`).

**`UNIQUE (acl_fingerprint, vault_id)` excludes `generation` on purpose.** A regenerated set
replaces its predecessor in place, so growth is bounded by distinct fingerprints rather than by
generations.

**The surrogate `set_id` exists for row size.** `WITHOUT ROWID` wants average rows below 1/20 of a
page; live `page_size` is 4096, so the budget is 204.8 bytes. Repeating the 64-char SHA-256
fingerprint on every member row costs 165 bytes at the longest live path (81% of budget) and
re-stores 71.6 KiB of identical hash. Interning gives 104 bytes worst case (51%) and makes eviction
one statement.

**`ON DELETE CASCADE` is the primary safety control, and the trigger is LRU eviction.**

Two separate hazards, both reproduced rather than reasoned about:

*Orphaning.* `INSERT OR REPLACE` is DELETE + INSERT: on a `UNIQUE` conflict it deletes the set row
and inserts a fresh one with a **new `set_id`**, stranding every member under the old id. Measured:
`set_id 1 -> 2`, member left at 1. Writes therefore use UPSERT, never `REPLACE`.

*Rowid reuse — the actual leak.* Without `AUTOINCREMENT`, SQLite reuses a deleted rowid when the
row deleted held the **largest** one. That is not an exotic case here: **LRU eviction deletes a set
row every time the cap binds**, and the evicted row is frequently the maximum. Reproduced end to
end with `foreign_keys = OFF`:

| `foreign_keys` | after evicting B (`set_id=2`, max) | caller C | result |
| --- | --- | --- | --- |
| `OFF` | member stranded at `set_id=2` | **reuses id 2** | reads B's path — **cross-principal leak** |
| `ON` + cascade | members removed with the set | reuses id 2 | sees nothing — clean |

An earlier draft of this design attributed the leak to `REPLACE`. That was wrong: `REPLACE` causes
orphaning, but in the tested scenario ids kept increasing and nothing leaked. Eviction is what makes
reuse routine, so the cascade is not a secondary precaution — it is the control that closes this.

**Do not let correctness depend on a PRAGMA.** `foreign_keys` is a per-connection runtime setting,
not a schema guarantee; all three adapters set it ON today, but a raw connection opened by a script
or a future harness would silently lose the cascade and restore the leak. Eviction therefore
**explicitly deletes members first**, then the set row, in one transaction. The cascade stays as the
backstop for any path that forgets. `20260519_001_initial.sql` is the cascade precedent.

```sql
INSERT INTO acl_path_sets (acl_fingerprint, vault_id, generation, built_at, path_count)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(acl_fingerprint, vault_id) DO UPDATE SET
  generation = excluded.generation,
  built_at   = excluded.built_at,
  path_count = excluded.path_count;
```

The other `WITHOUT ROWID` limitations were checked and none apply: no `AUTOINCREMENT` (unused), no
incremental blob I/O (unused), `last_insert_rowid()` unchanged (members are bulk-inserted, never
read back by rowid), update hooks not firing (**zero** hits for `updateHook|update_hook` in `src/`;
`WriteTxnHooks` is lock-wait telemetry, not `sqlite3_update_hook`).

## The module

`packages/server/src/search/acl_path_set.ts`, shaped like `generation.ts` — small, injected
`Database`, degrades on a pre-migration db.

```ts
export function ensureAclPathSet(db: Database, opts: {
  vaultId: string;
  aclFingerprint: string;
  generation: number;
  allPaths: () => string[];              // the universe, injected
  isReadable: (rel: string) => boolean;  // readableRel bound to this caller
  nowMs: number;
  maxSets?: number;                      // default 32
}): number | null;                       // set_id, or null => unavailable; caller keeps its JS filter
```

Rebuild runs in one transaction: UPSERT the set row, `DELETE FROM acl_path_members WHERE set_id = ?`,
batch insert, verify `path_count > 0`, commit. Eviction is LRU on `built_at` once the stored set
count exceeds `maxSets`.

**Store the path exactly as the DB holds it.** 35 live paths contain non-ASCII. `readableRel`
NFC-normalizes internally to decide, but the join key must be byte-identical to `chunks.path`, so
the build passes the raw DB string to `readableRel` and stores that same raw string. Decision and
key stay aligned and the join is identity rather than normalization-dependent.

## Invalidation and the security argument

`acl_fingerprint` covers *who is asking*; `generation` covers *what exists*.

For a fixed `(fingerprint, path-string)`, `readableRel` is **constant over time**. Its only inputs
are `isDefaultDenied(rel)` (a pure function of the path string), `acl.matchedPathGlob("read", rel)`
(compiled from `cfg.readPaths`), and `acl.strictReadDefault` — and `aclFingerprint` canonicalizes
all three. The `FolderAcl` constructor snapshots its config precisely so the fingerprint and the
enforced rules are frozen against the same source.

That yields the property this design rests on:

| disagreement between set and truth | consequence | direction |
| --- | --- | --- |
| readable path **missing** from set | chunks/edges excluded | recall loss — safe |
| set holds a path that **no longer exists** | joins to nothing | inert — safe |
| set holds an **existing but unreadable** path | would be a leak | **cannot occur** |

The third row needs `readableRel` to flip under a fixed fingerprint, which purity forbids. An ACL
change produces a different fingerprint, and a set built under the old one is **unreachable**, not
stale-but-readable. A missed `generation` bump therefore costs recall, never confidentiality —
which matters because generation is the weaker key, bumped from five call sites.

**The empty-set trap.** If `allPaths()` returns empty, the set materializes empty and every query
filters to nothing while looking healthy. `ensureAclPathSet` refuses to persist a zero-member set
while the universe is non-empty, returns `null`, and the caller keeps its JS filter.

**Write-on-read.** The build writes during a read query. Read-only handles exist (the eval harness,
`doctor --probe`): the build catches, returns `null`, and never throws. Concurrent builders are
benign under UPSERT. The `readEnumerationUnrestricted(acl)` fast path skips the set entirely, which
on a single-principal deployment is the only branch taken.

## Consumers

**`termDf` (`search/router.ts`) — THE-694.** No join. When `readEnumerationUnrestricted(acl)` is
false, skip rare-term classification and return `standard` routing. The unrestricted path keeps its
existing exact `COUNT(*)`.

**`bm25Chunks` (`search/chunk_fts.ts`) — THE-695 item 2.** Join `acl_path_members` and delete the
`F = k*20 + 50` over-fetch. Exact filtering removes the underfill boundary, so the returned length
no longer depends on how many higher-scoring hidden rows exist. This returns *more* rows in the
underfill case — a recall improvement, but a behaviour change.

**Graph walk (`search/graph_expand.ts`) — THE-695 item 1, behind a flag.** Join
`acl_path_members` inside the recursive CTE so an unreadable note cannot serve as a bridge.
Measured on a live snapshot with a restricted ACL: 583 nodes unfiltered, 57 filtered, at
37.9 ms vs 38.6 ms — the join is free relative to the walk, and the recall change is large.

That last one is why it ships dark. THE-693's `hubDegreeCap` lands in the same file and prunes on
degrees `nodeDegrees` computes with no ACL, so both must be evaluated in one pass rather than
sequentially.

## Testing

- **THE-694 guardrail is a timing-distribution test, not a config assertion.** Assert that
  hidden-only and absent terms are statistically indistinguishable. The failing baseline is already
  captured (72x, non-overlapping) and is what the test must be watched failing against.
- **Bridge test:** `readable A -> unreadable S -> readable B` at `hopLimit=2`; assert B is absent
  with the flag on and present with it off.
- **Empty-set floor:** a build whose universe is non-empty but whose member count is 0 must refuse
  to persist and return `null`.
- **Rowid-reuse leak regression, watched failing first.** Evict the set holding the largest
  `set_id` (the LRU path), then create a new set; assert the new set sees zero members. The failing
  baseline is reproducible today by setting `foreign_keys = OFF`, which is how this hazard was found
  — the test must be watched failing under that PRAGMA before it is trusted.
- **Eviction does not depend on the PRAGMA:** with `foreign_keys = OFF`, eviction must still leave
  no members behind, because it deletes them explicitly rather than relying on the cascade.
- **Fingerprint isolation:** two fingerprints over the same vault must not see each other's members.
- **Pre-migration degradation:** a `cache.db` without the tables returns `null` and every consumer
  keeps working.

## Rollout

1. Migration + module + tests. Closes nothing on its own.
2. `termDf` restricted-caller skip. **Closes THE-694.**
3. `bm25Chunks` join. **Closes THE-695 item 2.**
4. Walk filter behind a config flag, dark.

## Measured after implementation: the walk filter cannot be evaluated on this corpus

The plan called for a three-arm eval covering both THE-693's hub defence and THE-695's walk filter.
Only the first is measurable here.

`eval/run.ts` never populates `isReadable` — there is no `--acl` flag and no assignment anywhere in
the harness — so the eval runs **fully unrestricted**. With every path readable the permitted set
contains the whole universe, and the walk join prunes nothing. Demonstrated rather than argued, on
the real store: a set built with `isReadable: () => true` held all **1,146** paths, and across 60
real seeds the 2-hop walk returned **identical** node sets with and without the join — 13,130 nodes
both ways, **0 differing seeds**.

So an `--acl-walk-filter` arm would return a guaranteed null, and reporting that as "no measured
effect" would be false: it is *no possible* effect, which is a different claim.

This also settles the production question. Cave is single-principal, so
`readEnumerationUnrestricted(acl)` is true, the fast path never calls `ensureAclPathSet`, and the
walk filter never engages — it is **inert in this deployment by construction**. Its recall cost is
borne only by restricted callers, who are exactly the callers the non-interference property
protects. That is a design argument, not a measurement, and it should be recorded as one.

Evaluating it properly would need a golden set scored against a *restricted* principal — a
different corpus and a different question than THE-674's bar answers.

5. **THE-693 only:** three-arm eval (off / hard cap / smooth damping) at n=250 against the standing
   bar, sigma_d 0.204 / MDE 0.036 (THE-674). **Closes THE-693** on the measured outcome.
