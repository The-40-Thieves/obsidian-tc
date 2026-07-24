# Derived-cognition plane isolation — THE-563 / THE-564 (+ audit #9, P1.6 deep-half)

**Date:** 2026-07-24
**Parent:** THE-562 (Codex full-repo audit 2026-07-23 triage)
**Tickets:** THE-563 (P0.1), THE-564 (P0.2), plus two "cheap mechanical" tail items folded from THE-562's body: audit #9 (migration completeness gate) and P1.6 deep-half (`reflect.persist` governed write).
**Baseline:** `main` @ `b2209bd`.

## Problem

The derived-cognition plane (contradictions, syntheses, and the reflect/challenge surfaces that read them) does not carry a vault namespace, and does not re-authorize the *sources* of a derived row before returning it. Two consequences:

1. **No namespace (THE-563).** `contradictions` has no `vault_id`; `syntheses` is keyed `(iso_year, iso_week)` — one global row per ISO week. `runSynthesis` reads chunks from *every* vault and writes one blended weekly record. Path-equal notes in different vaults collide on the contradiction readers. Single-user today (a privacy-hygiene/correctness failure — the weekly synthesis blends the `agents` and `main` vaults); a cross-domain leak where vaults are authorization domains (the public product's SECURITY.md claim).

2. **No all-source re-authorization (THE-564).** A derived row references two sources (`source_path`, `conflict_path`). Readers verify only the paths the caller supplied / the packed evidence, then surface *both* sides plus a model rationale — the opposite side can be outside the caller's readable set, and can be sent to the inference gateway.

Both are the same defect class as already-fixed tickets: THE-310 (added `vault_id` to `vault_edges`) and THE-543 (rechecked every prewarm-cache path against the caller ACL before serving). This work extends those established patterns to the plane.

## Invariants (the contract this work establishes)

- **I1 — Namespace retention.** Every derived object retains its vault namespace through creation, storage, retrieval, invalidation, and model use.
- **I2 — All-source authorization.** A derived object may be returned, summarized, cached, or sent to a model only if **every** contributing source remains visible to the current principal. The vault predicate (I1) is the first gate; per-path ACL is the second.

## Scope

**In scope**

| # | Item | Ticket |
|---|------|--------|
| 1 | `vault_id` on `contradictions` + `syntheses`; per-vault synthesis + contradiction persistence | THE-563 |
| 2 | All-source ACL recheck on contradiction read/challenge/model-egress paths | THE-564 |
| 3 | Migration file/manifest completeness CI gate | audit #9 |
| 4 | Route `reflect.persist` through the governed note-write service | audit P1.6 (deep half) |

**Out of scope** (remain tracked in THE-562's body, decided item-by-item later): P1.4 (rule-scope enforcement vs doc-deprecate), P1.5 (`read:docs` vault `kind`), P1.7 (caller partitioning authorization), P1.8 (learned-state namespace doc), #10 (release cut), #13 (idempotency finalize-fault), #14 (job-queue workload), #15 (`bm25_weight`), #16 (retrieval-head health), #17 (`npx`/Windows boundary).

## Design

### Item 1 — THE-563: namespace the plane

**Migration** — new `packages/server/src/migrations/20260724_001_plane_vault_id.sql`, appended to `CACHE_MIGRATIONS` in `db/provision.ts` (version `20260724_001`).

Contradictions and syntheses are **regenerable derived caches** — contradictions re-flag on the next reindex, syntheses regenerate on the next weekly run. Existing rows have no recoverable `vault_id` (a contradiction may pair chunks from different vaults; a synthesis blended all vaults). Following THE-310's `vault_edges` precedent, we **purge** rather than backfill a guessed value.

> **Note (industry-default vs this case).** The general multi-tenant guidance (Citus, Azure Cosmos for PostgreSQL) is to add `tenant_id` and **backfill** existing rows — but that assumes the correct value is *recoverable* (e.g. deriving `store_id` on `line_items` via a join to `orders`). That precondition fails here: the correct namespace of a blended contradiction/synthesis row is unrecoverable. When the value is unrecoverable **and** the data regenerates, purge is the justified exception to the backfill default — the same reasoning THE-310 applied. (Validated by deep research 2026-07-24; report in the branch scratchpad.)

```sql
-- contradictions: purge unscoped rows, add vault_id, re-scope the dedup index.
DELETE FROM contradictions;
ALTER TABLE contradictions ADD COLUMN vault_id TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_contradictions_pair;
CREATE UNIQUE INDEX idx_contradictions_pair
  ON contradictions(vault_id, source_content_sha, conflict_content_sha);
CREATE INDEX IF NOT EXISTS idx_contradictions_vault ON contradictions(vault_id);

-- syntheses: composite PK can't be altered in place; recreate with vault_id in the PK.
-- DROP discards the unscoped rows (purge); no separate DELETE needed.
DROP TABLE syntheses;
CREATE TABLE syntheses (
  vault_id      TEXT NOT NULL,
  iso_year      INTEGER NOT NULL,
  iso_week      INTEGER NOT NULL,
  generated_at  INTEGER NOT NULL,
  cluster_count INTEGER NOT NULL,
  pattern_count INTEGER NOT NULL,
  clusters      TEXT NOT NULL,
  patterns      TEXT NOT NULL,
  judge_model   TEXT,
  PRIMARY KEY (vault_id, iso_year, iso_week)
);
```

The `DEFAULT ''` on the contradictions column exists only to satisfy `NOT NULL` during the `ALTER` on an emptied table; no row is ever written with `''` because every writer supplies a real `vault_id`.

**Writer — `plane/jobs/contradiction.ts` `checkContradictions`.** Already receives `vaultId` and scopes neighbor search per-vault; it only drops the vault on persist. Changes:
- Add `vault_id` to the `INSERT` column list and bind `vaultId`.
- Fold `vaultId` into the dedup id so identical sha-pairs across two vaults don't collide on the primary key: `ctr_${contentHash(`${vaultId}:${src.sha}:${con.sha}`).slice(0, 24)}`.

**Writer — `plane/jobs/synthesis.ts` `runSynthesis`.** Currently reads global chunks + global contradictions and writes one global row. Change to run **per vault**, self-contained (no `JobContext` change):
- Enumerate vaults from content: `SELECT DISTINCT vault_id FROM chunks`.
- For each vault: scope the recent-chunks read (`... WHERE vault_id = ? ORDER BY updated_at DESC LIMIT ?`) and the open-contradictions read (`... WHERE status = 'open' AND vault_id = ? ...`) by that id; run the gateway synthesize call; upsert keyed `(vault_id, iso_year, iso_week)`.
- A vault with zero recent chunks is skipped (unchanged per-vault version of today's `no chunks` short-circuit). `JobResult.detail` reports per-vault counts (`{ vaults: [{ vault_id, patterns, clusters }] }`).

Rationale for `DISTINCT vault_id FROM chunks` over threading `VaultRegistry`: synthesis operates on whatever vaults actually hold content, keeps the plane `Job` interface untouched, and keeps the unit tests (which call `runSynthesis` with a bare `JobContext`) working without a registry stub.

**Readers** (vault predicate added; this is also I2's first gate):
- `tools/m7/knowledge-tools.ts` `vault_context` synthesis LIKE query (~line 430): add `AND vault_id = ?` bound to `input.vault`.
- `openContradictionsForPaths` (see Item 2 — gains a `vaultId` parameter and a `WHERE vault_id = ?` predicate).

### Item 2 — THE-564: all-source ACL on derived objects

Mirror THE-543's prewarm recheck (`readableRel(ctx.acl, rel)` over every referenced path).

**`openContradictionsForPaths`** — signature changes from `(db, paths)` to `(db, vaultId, paths, isReadable)`:
- `WHERE vault_id = ?` (I1 gate) **and** `(source_path IN (...) OR conflict_path IN (...))` as today.
- After fetch, drop any row where `!isReadable(source_path) || !isReadable(conflict_path)`. Today only the *matched* side is guaranteed readable (it came from the already-filtered packed notes); the opposite side is the leak.
- Callers pass `(rel) => readableRel(ctx.acl, rel)`:
  - `vault_context` (knowledge-tools.ts:416), `vaultId = v.id`.
  - direct `list_contradictions` tool (~line 1064), `vaultId = resolved vault id`.

**Challenge / model-egress path** (`plane/challenge.ts` via `knowledge_challenge`): the challenge tool composes open contradictions into the gateway prompt through the same `openContradictionsForPaths` helper. Once the helper filters, the model-egress path is covered by the identical gate. A regression test asserts a row whose conflict-side note is unreadable never appears in the composed challenge prompt.

**Syntheses boundary (explicit).** A synthesis row is a whole-vault aggregate and does **not** carry a per-source path list, so per-path ACL is not enforceable on it — the vault predicate (I1) is the enforceable gate: a caller with any read grant in the vault may see that vault's synthesis patterns. This is stated as a known boundary, not silently skipped; it matches the audit framing ("563 = first gate for syntheses").

**Two-layer design is deliberate (pre- + post-fetch).** OWASP's RAG guidance prefers pushing authorization *into* the query (pre-retrieval) over "retrieve-all-then-filter," whose risk is leaking the *similarity scores* of restricted documents. This design already pushes the coarse gate into SQL — the vault predicate (`WHERE vault_id = ?`, I1) is pre-retrieval — and applies the per-path ACL as a **post-fetch drop**, mirroring THE-543's shipped layer-3 recheck. The score-leak concern is vector-search-specific (ANN ranking); it does not transfer to a `contradictions` lookup keyed on exact path membership, so post-fetch dropping of unreadable-source rows is sound here. Per-path ACL is not cleanly SQL-expressible for folder-glob rules, and THE-543 already sets the post-fetch-recheck precedent. (Validated by deep research 2026-07-24.)

### Item 3 — audit #9: migration completeness gate

Two hand-enumerated chains reference `migrations/*.sql` by string:
- `CACHE_MIGRATIONS` in `db/provision.ts` (cache.db chain).
- `experientialMigrations` in `cli.ts` (experiential.db chain).

A `.sql` file on disk referenced by **neither** list silently never runs. Fix — make the filenames introspectable and assert a bijection:
- Give each `CACHE_MIGRATIONS` entry an explicit `file:` field (it already passes the filename to `sql("<file>")`; lift it to data). Export the experiential chain's filename list from `cli.ts` (or a small shared module) so a test can read it without importing the CLI entry point's side effects — preferred: a `MIGRATION_FILES` export listing both chains' files.
- New test `packages/server/src/db/__tests__/migrations-manifest.test.ts`: glob `migrations/*.sql`; assert every file on disk is referenced by exactly one chain, and every referenced file exists on disk. A new/renamed `.sql` with no registration fails CI.

Minimal: no codegen — a single assertion over the two source-of-truth lists.

### Item 4 — audit P1.6 (deep half): `reflect.persist` governed write

`reflect.persist` (knowledge-tools.ts:731) writes with a raw `writeFileSync` to a deterministic `reflections/YYYY-MM-DD-<slug>.md`, bypassing:
- **snapshot** (`captureSnapshot`) → same-query-same-day overwrite has no recovery point,
- **atomic write** (`writeNoteAtomic` tmp+rename) → a reader can catch a torn file,
- **index-on-write + generation bump** (`deps.reindex`) → the derived note is never indexed and stale caches aren't invalidated.

The scope-check half of P1.6 (wildcard-aware `grantsAll`) is already fixed (THE-562 / PR #396).

Fix:
- Extract the governed core of `write_note` (notes-tools.ts:455–458: read-prior → `captureSnapshot` → `writeNoteAtomic` → `reindex`) into a small shared helper in `vault/` (e.g. `persistGovernedNote`) so `write_note` and `reflect.persist` cannot drift.
- Thread `snapshots` + `reindex` into `M7Deps`, wired in `cli.ts` from the same handles M1 uses.
- `reflect.persist` calls the helper. It skips interactive CAS/confirmation: reflect owns this deterministic path, the caller does not manage `prev_hash`. `enforcePathAcl(ctx.acl, "write", rel, v.root)` stays as-is before the write.

## Testing

TDD per item — a failing test proven to fail against the unfixed code, then the fix.

- **563.** Migration test: emptied tables gain `vault_id`, indexes/PK reshaped. `checkContradictions` writes `vault_id`; two vaults with the same sha-pair both persist (no PK collision). `runSynthesis` over a two-vault fixture writes two rows, each blending only its own vault's chunks/contradictions. Reader vault-predicate tests.
- **564.** `openContradictionsForPaths`: a contradiction whose conflict-side note is unreadable is dropped; a fully-readable one survives. Challenge path: unreadable-conflict row absent from the composed prompt. Cross-vault row (wrong `vault_id`) never returned.
- **#9.** Manifest test fails when a stray `.sql` is added with no registration (proven by a temp fixture or by asserting the current bijection holds and the assertion is real).
- **P1.6.** `reflect.persist` twice same-day produces a snapshot of the first; the written note is atomic and reindexed (assert `reindex` seam called with `(v.id, rel, content)`).

Gate before merge: `biome` + `tsc` (×4 packages) + server test suite green.

## Delivery

- Isolated **git worktree** off `main` (the `~/obsidian-tc` symlink shares `.git` with `~/src/obsidian-tc`; `[ -d .git ]` is not isolation — use `git worktree add`).
- Commits in dependency order: **563 → 564 → #9 → P1.6**, each DCO-signed (`git commit -s`).
- One PR under parent THE-562. Merge only once the full gate is green and CI has a non-zero check count (no stale/zero-run green).

## Risks / notes

- **Live-data purge (Cave).** The migration wipes the current weekly synthesis and open contradiction flags on the live `cache.db`; both regenerate on the next reindex / weekly run. Acceptable and intended (chosen "purge" disposition).
- **`DISTINCT vault_id FROM chunks` cost.** Small cardinality (vault count), indexed scan; negligible vs the gateway synthesize call it precedes.
- **Two-list #9 gate must classify each file to a chain.** A file legitimately in the experiential chain must not be flagged as a cache-chain omission — the test asserts *union* coverage, not per-list coverage.
