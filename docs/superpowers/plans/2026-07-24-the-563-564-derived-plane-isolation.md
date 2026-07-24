# Derived-Cognition Plane Isolation (THE-563 / THE-564 + #9 + P1.6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every derived-cognition object (`contradictions`, `syntheses`) a `vault_id`, run the plane per-vault, re-authorize every contributing source of a derived row before it is returned or sent to a model, and close two folded tail items (migration completeness gate, `reflect.persist` governed write).

**Architecture:** Two layered gates established by shipped precedents — a vault predicate (THE-310's `vault_id`-on-derived-tables) as the coarse gate, and a per-path ACL recheck (THE-543's prewarm recheck) as the fine gate. Regenerable derived rows with no recoverable vault are **purged**, not backfilled. The plane job enumerates vaults from `SELECT DISTINCT vault_id FROM chunks`, so no `JobContext` interface change is needed.

**Tech Stack:** TypeScript, Bun runtime, Vitest, SQLite (better-sqlite3-compatible `Database` interface), monorepo package `@the-40-thieves/obsidian-tc-server`.

## Global Constraints

- **Commits:** DCO-signed (`git commit -s`); every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. One ticket per commit; order **563 → 564 → #9 → P1.6**.
- **Purge, not backfill:** existing `contradictions`/`syntheses` rows are deleted by the migration (unrecoverable vault + regenerable). Mirror THE-310's `20260703_001_vault_edges_vault_id.sql` header rationale.
- **Migration versioning:** filename `YYYYMMDD_NNN_<desc>.sql`; the registered `version` is the first two underscore segments (`20260724_001`). New migrations append to `CACHE_MIGRATIONS` in application order — never reorder existing entries.
- **ACL recheck is post-fetch drop** using `readableRel(ctx.acl, rel)` (matches THE-543 layer-3); the vault predicate is pushed into SQL (pre-fetch).
- **Gate before merge:** `bun run lint` (biome) + `tsc` across the 4 packages + the server test suite green, with a non-zero CI check count.
- **Tests live in** `packages/server/test/*.test.ts`; provision in-memory DBs via `openMemoryDb()` + `runMigrations()` from `./helpers` and `../src/db/migrate`.

---

## File Structure

**Item 1 — THE-563 (namespace)**
- Create: `packages/server/src/migrations/20260724_001_plane_vault_id.sql` — purge + reshape `contradictions`/`syntheses`.
- Modify: `packages/server/src/db/provision.ts` — register the migration.
- Modify: `packages/server/src/plane/jobs/contradiction.ts` — write `vault_id`; fold vault into dedup id.
- Modify: `packages/server/src/plane/jobs/synthesis.ts` — per-vault loop.
- Modify: `packages/server/src/tools/m7/knowledge-tools.ts` — `vault_context` syntheses vault predicate.
- Test: `packages/server/test/plane-vault-id-migration.test.ts` (new); update `contradiction-job.test.ts`, `synthesis-job.test.ts`.

**Item 2 — THE-564 (all-source ACL)**
- Modify: `packages/server/src/tools/m7/knowledge-tools.ts` — `openContradictionsForPaths` signature + both callers.
- Test: update `list-contradictions.test.ts`, `knowledge-challenge-evidence.test.ts`.

**Item 3 — audit #9 (migration completeness)**
- Create: `packages/server/src/db/migration-manifest.ts` — single source of truth for both chains' filenames.
- Modify: `packages/server/src/db/provision.ts` + `packages/server/src/cli.ts` — build chains from the manifest.
- Test: `packages/server/test/migrations-manifest.test.ts` (new).

**Item 4 — audit P1.6 (governed write)**
- Create: `packages/server/src/vault/persist-note.ts` — snapshot→atomic→reindex helper.
- Modify: `packages/server/src/tools/m7/knowledge-tools.ts` — `reflect.persist` routes through it; `M7Deps` gains `snapshots`/`reindex`.
- Modify: `packages/server/src/cli.ts` — wire `snapshots`/`reindex` into `registerM7Tools`.
- Modify: `packages/server/src/tools/m1/notes-tools.ts` — `write_note` reuses the helper.
- Test: `packages/server/test/reflect-persist-governed.test.ts` (new).

---

## Task 1: THE-563 migration — purge + reshape the plane tables

**Files:**
- Create: `packages/server/src/migrations/20260724_001_plane_vault_id.sql`
- Modify: `packages/server/src/db/provision.ts` (add entry after `20260723_002`)
- Test: `packages/server/test/plane-vault-id-migration.test.ts`

**Interfaces:**
- Consumes: `CACHE_MIGRATIONS` from `provision.ts`; `runMigrations(db, migrations, opts)` from `../src/db/migrate`.
- Produces: `contradictions` gains `vault_id TEXT NOT NULL`, unique index `idx_contradictions_pair(vault_id, source_content_sha, conflict_content_sha)`, index `idx_contradictions_vault(vault_id)`. `syntheses` PK becomes `(vault_id, iso_year, iso_week)` with a leading `vault_id TEXT NOT NULL` column.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/plane-vault-id-migration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import { runMigrations } from "../src/db/migrate";
import { openMemoryDb } from "./helpers";

describe("20260724_001 plane vault_id migration", () => {
  it("adds vault_id to contradictions and re-scopes the dedup index", () => {
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);
    const cols = (db.prepare("PRAGMA table_info(contradictions)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("vault_id");
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_contradictions_pair'")
      .get() as { sql: string };
    expect(idx.sql).toContain("vault_id");
  });

  it("rebuilds syntheses with vault_id in the primary key", () => {
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);
    const pk = (db.prepare("PRAGMA table_info(syntheses)").all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(pk).toEqual(["vault_id", "iso_year", "iso_week"]);
  });

  it("two vaults can hold the same synthesis week and the same contradiction sha-pair", () => {
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);
    const insSyn = db.prepare(
      "INSERT INTO syntheses (vault_id, iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns) VALUES (?, 2026, 30, 0, 0, 0, '[]', '[]')",
    );
    insSyn.run("v1");
    expect(() => insSyn.run("v2")).not.toThrow();
    const insCtr = db.prepare(
      "INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, judge_verdict, status, detected_at) VALUES (?, ?, 'sc', 'a.md', 'cc', 'b.md', 'sha1', 'sha2', 'tension', 'open', 0)",
    );
    insCtr.run("v1_pair", "v1");
    expect(() => insCtr.run("v2_pair", "v2")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/plane-vault-id-migration.test.ts`
Expected: FAIL — `vault_id` absent / PK is `(iso_year, iso_week)` / second insert throws UNIQUE.

- [ ] **Step 3: Write the migration**

Create `packages/server/src/migrations/20260724_001_plane_vault_id.sql`:

```sql
-- 20260724_001_plane_vault_id.sql
-- THE-563: namespace the derived-cognition plane. contradictions + syntheses predate the shared
-- cache.db vault_id isolation that chunks/notes/embeddings carry. Both are REGENERABLE derived
-- caches (contradictions re-flag on the next reindex; syntheses regenerate on the next weekly run)
-- and their historical vault is UNRECOVERABLE (a contradiction may pair chunks from two vaults; a
-- synthesis blended every vault). So we PURGE the unscoped rows rather than backfill a guess -- the
-- same disposition THE-310 (20260703_001) took for vault_edges. Writers repopulate scoped.

-- contradictions: purge, add vault_id, re-scope the pair-dedup index to include it so two vaults may
-- hold the same content-sha pair. NOT NULL DEFAULT '' satisfies the ALTER on the emptied table; no
-- row is ever written with '' (every writer supplies a real vault_id).
DELETE FROM contradictions;
ALTER TABLE contradictions ADD COLUMN vault_id TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_contradictions_pair;
CREATE UNIQUE INDEX idx_contradictions_pair
  ON contradictions(vault_id, source_content_sha, conflict_content_sha);
CREATE INDEX IF NOT EXISTS idx_contradictions_vault ON contradictions(vault_id);

-- syntheses: a composite PK cannot be altered in place. DROP discards the unscoped rows (purge) and
-- the table is recreated with vault_id leading the PK so each vault owns one row per ISO week.
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

Register it in `packages/server/src/db/provision.ts` — add as the last entry of `CACHE_MIGRATIONS`:

```ts
  { version: "20260723_002", sql: sql("20260723_002_jobs.sql") },
  { version: "20260724_001", sql: sql("20260724_001_plane_vault_id.sql") },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bunx vitest run test/plane-vault-id-migration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/migrations/20260724_001_plane_vault_id.sql packages/server/src/db/provision.ts packages/server/test/plane-vault-id-migration.test.ts
git commit -s -m "feat(THE-563): migrate contradictions/syntheses to per-vault namespace (purge)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: THE-563 — contradiction writer persists vault_id

**Files:**
- Modify: `packages/server/src/plane/jobs/contradiction.ts:78-80` (INSERT) and `:138` (dedup id)
- Test: `packages/server/test/contradiction-job.test.ts` (update inline table DDL; add a two-vault assertion)

**Interfaces:**
- Consumes: `checkContradictions(ctx, vaultId, chunks)` already receives `vaultId`.
- Produces: rows in `contradictions` carry `vault_id`; the row id is `ctr_<hash(vaultId:srcSha:conSha)>` so identical sha-pairs in two vaults do not collide on the primary key.

- [ ] **Step 1: Update the test's table DDL and add the failing assertion**

In `packages/server/test/contradiction-job.test.ts`, find the inline `CREATE TABLE contradictions (...)` used by the test setup and replace it with the migrated shape (add `vault_id`, re-scope the unique index):

```ts
db.exec(
  "CREATE TABLE contradictions (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL DEFAULT '', source_chunk_id TEXT NOT NULL, source_path TEXT NOT NULL, conflict_chunk_id TEXT NOT NULL, conflict_path TEXT NOT NULL, source_content_sha TEXT NOT NULL, conflict_content_sha TEXT NOT NULL, cosine_similarity REAL, judge_verdict TEXT NOT NULL, judge_rationale TEXT, judge_model TEXT, status TEXT NOT NULL DEFAULT 'open', detected_at INTEGER NOT NULL, resolved_at INTEGER);" +
  "CREATE UNIQUE INDEX idx_contradictions_pair ON contradictions(vault_id, source_content_sha, conflict_content_sha);",
);
```

Add a test asserting the persisted row carries the vault id (place after the existing "flags a contradiction" test; reuse that test's fixture builders):

```ts
it("persists vault_id on the flagged row", async () => {
  const { db, roles } = setupConflictingPair(); // existing helper in this file
  await checkContradictions({ db, roles, now: () => 0 }, "vault-A", chunksFor(db));
  const row = db.prepare("SELECT vault_id FROM contradictions LIMIT 1").get() as { vault_id: string };
  expect(row.vault_id).toBe("vault-A");
});
```

> If this test file has no `setupConflictingPair`/`chunksFor` helpers, mirror the existing passing test's setup verbatim and only change the assertion — do not invent new fixture helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/contradiction-job.test.ts`
Expected: FAIL — INSERT has no `vault_id` column binding / new assertion reads empty string.

- [ ] **Step 3: Implement the writer change**

In `packages/server/src/plane/jobs/contradiction.ts`, update the prepared INSERT (currently line 78-80) to include `vault_id`:

```ts
  const insert = ctx.db.prepare(
    "INSERT OR IGNORE INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, cosine_similarity, judge_verdict, judge_rationale, judge_model, status, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
  );
```

Update the id derivation and the `insert.run(...)` call (currently line 138-152):

```ts
    const id = `ctr_${contentHash(`${vaultId}:${src.sha}:${con.sha}`).slice(0, 24)}`;
    const info = insert.run(
      id,
      vaultId,
      src.id,
      src.path,
      con.id,
      con.path,
      src.sha,
      con.sha,
      t.score,
      verdict.kind,
      verdict.rationale,
      model,
      ctx.now(),
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bunx vitest run test/contradiction-job.test.ts test/contradiction-drain.test.ts test/contradiction-parallel.test.ts test/contradiction-gc.test.ts`
Expected: PASS. (Update the same inline `CREATE TABLE contradictions` DDL in any of these files that provision the table and fail — the shape must match the migration.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/plane/jobs/contradiction.ts packages/server/test/contradiction-*.test.ts
git commit -s -m "feat(THE-563): contradiction writer persists vault_id + vault-scoped dedup id

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: THE-563 — synthesis runs per vault

**Files:**
- Modify: `packages/server/src/plane/jobs/synthesis.ts:92-149` (`runSynthesis`)
- Test: `packages/server/test/synthesis-job.test.ts` (update `withChunksDb` DDL; add a two-vault test)

**Interfaces:**
- Consumes: `JobContext` (unchanged) — `ctx.db`, `ctx.roles`, `ctx.now`.
- Produces: one `syntheses` row per vault that has chunks, keyed `(vault_id, iso_year, iso_week)`; `JobResult.detail` is `{ iso_year, iso_week, vaults: [{ vault_id, patterns, clusters }] }` (or `{ skipped }`).

- [ ] **Step 1: Update the test DDL and write the failing two-vault test**

In `packages/server/test/synthesis-job.test.ts`, replace the inline `CREATE TABLE syntheses (...)` in `withChunksDb()` with the migrated shape:

```ts
db.exec(
  "CREATE TABLE syntheses (vault_id TEXT NOT NULL, iso_year INTEGER NOT NULL, iso_week INTEGER NOT NULL, generated_at INTEGER NOT NULL, cluster_count INTEGER NOT NULL, pattern_count INTEGER NOT NULL, clusters TEXT NOT NULL, patterns TEXT NOT NULL, judge_model TEXT, PRIMARY KEY (vault_id, iso_year, iso_week));",
);
```

Add a two-vault test:

```ts
it("writes one synthesis per vault, each blending only its own vault's chunks", async () => {
  const db = withChunksDb();
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('a', 'v1', 'A.md', '0', '[]', 'note one', 'h1', 1, 0, 1)",
  ).run();
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('b', 'v2', 'B.md', '0', '[]', 'note two', 'h2', 1, 0, 1)",
  ).run();
  const synth =
    '{"patterns":[{"title":"t","summary":"s","evidence_paths":["A.md"],"contradiction_ids":[]}],"clusters":[{"label":"l","summary":"s","chunk_paths":["A.md"]}]}';
  const res = await runSynthesis({ db, roles: rolesReturning(synth), now: () => Date.UTC(2026, 5, 1) });
  expect(res.ok).toBe(true);
  const vaults = (db.prepare("SELECT vault_id FROM syntheses ORDER BY vault_id").all() as { vault_id: string }[]).map((r) => r.vault_id);
  expect(vaults).toEqual(["v1", "v2"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/synthesis-job.test.ts`
Expected: FAIL — one global row (no `vault_id`) is written; the two-vault query returns `['']` or a single row.

- [ ] **Step 3: Rewrite `runSynthesis` to loop per vault**

Replace the body of `runSynthesis` in `packages/server/src/plane/jobs/synthesis.ts` (lines 92-149) with:

```ts
export async function runSynthesis(ctx: JobContext): Promise<JobResult> {
  const roles: GatewayRoles | null = ctx.roles;
  if (!roles) return { ok: false, detail: { skipped: "no gateway roles" } };

  // Per-vault: synthesis operates on whatever vaults actually hold content, so the plane Job
  // interface stays vault-free. DISTINCT over the indexed vault_id column is a small scan.
  const vaults = (
    ctx.db.prepare("SELECT DISTINCT vault_id FROM chunks").all() as { vault_id: string }[]
  ).map((r) => r.vault_id);
  if (vaults.length === 0) return { ok: true, detail: { skipped: "no chunks" } };

  const hasContradictions =
    ctx.db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'contradictions'")
      .get() !== undefined;

  const iso = isoWeek(new Date(ctx.now()));
  const perVault: Array<{ vault_id: string; patterns: number; clusters: number }> = [];

  for (const vaultId of vaults) {
    const recent = ctx.db
      .prepare(
        "SELECT path, chunk_index, headings, content FROM chunks WHERE vault_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(vaultId, RECENT_LIMIT) as ChunkRow[];
    if (recent.length === 0) continue;

    const contradictions = hasContradictions
      ? (ctx.db
          .prepare(
            "SELECT id, source_path, conflict_path, judge_verdict, judge_rationale FROM contradictions WHERE status = 'open' AND vault_id = ? ORDER BY detected_at DESC LIMIT ?",
          )
          .all(vaultId, CONTRADICTION_LIMIT) as ContradictionRow[])
      : [];

    const res = await roles.synthesize(
      prompt(SYSTEM_PROMPT, buildUserMessage(recent, contradictions)),
    );
    let synthesis: SynthesisOutput;
    try {
      synthesis = parseSynthesis(res.text);
    } catch (e) {
      return { ok: false, detail: { vault_id: vaultId, error: (e as Error).message } };
    }

    ctx.db
      .prepare(
        "INSERT INTO syntheses (vault_id, iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns, judge_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(vault_id, iso_year, iso_week) DO UPDATE SET generated_at = excluded.generated_at, cluster_count = excluded.cluster_count, pattern_count = excluded.pattern_count, clusters = excluded.clusters, patterns = excluded.patterns, judge_model = excluded.judge_model",
      )
      .run(
        vaultId,
        iso.year,
        iso.week,
        ctx.now(),
        synthesis.clusters.length,
        synthesis.patterns.length,
        JSON.stringify(synthesis.clusters),
        JSON.stringify(synthesis.patterns),
        res.model,
      );
    perVault.push({
      vault_id: vaultId,
      patterns: synthesis.patterns.length,
      clusters: synthesis.clusters.length,
    });
  }

  if (perVault.length === 0) return { ok: true, detail: { skipped: "no chunks" } };
  return { ok: true, detail: { iso_year: iso.year, iso_week: iso.week, vaults: perVault } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bunx vitest run test/synthesis-job.test.ts`
Expected: PASS. The pre-existing single-vault test still passes (one vault → one row); update its post-run row lookup to `SELECT ... FROM syntheses WHERE vault_id = 'v1'` if it selected an unscoped single row.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/plane/jobs/synthesis.ts packages/server/test/synthesis-job.test.ts
git commit -s -m "feat(THE-563): synthesis runs per vault, one weekly row per vault

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: THE-563 — `vault_context` scopes syntheses by vault

**Files:**
- Modify: `packages/server/src/tools/m7/knowledge-tools.ts:433-437` (syntheses SELECT)
- Test: `packages/server/test/knowledge-search.test.ts` (add a cross-vault synthesis-isolation assertion) — or a new `packages/server/test/vault-context-syntheses-scope.test.ts` if the search test does not already exercise `vault_context` syntheses.

**Interfaces:**
- Consumes: `input.vault` → `v.id` (already resolved at the top of the `vault_context` handler).
- Produces: the syntheses leg returns only rows where `vault_id = v.id`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/vault-context-syntheses-scope.test.ts`. Provision a cache.db via `runMigrations(db, CACHE_MIGRATIONS)`, insert one synthesis row for `v2` whose `patterns` JSON contains a significant query token, build the `vault_context` tool with a `vaultRegistry` holding `v1` + `v2`, call it with `vault: "v1"` and a query using that token, and assert the response `syntheses` array is empty (the `v2` row must not leak into a `v1` call).

```ts
import { describe, expect, it } from "vitest";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import { runMigrations } from "../src/db/migrate";
import { openMemoryDb } from "./helpers";
import { buildKnowledgeTools } from "../src/tools/m7/knowledge-tools";
import { VaultRegistry } from "../src/vault/registry";
// Reuse this file's existing M7Deps builder helper if one exists in the test dir; otherwise
// construct the minimal deps mirroring knowledge-search.test.ts's setup.

describe("vault_context syntheses are vault-scoped (THE-563)", () => {
  it("does not surface another vault's synthesis patterns", async () => {
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);
    db.prepare(
      "INSERT INTO syntheses (vault_id, iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns) VALUES ('v2', 2026, 30, 1, 0, 1, '[]', ?)",
    ).run(JSON.stringify([{ title: "kubernetes drift", summary: "s", evidence_paths: [], contradiction_ids: [] }]));
    // ... build vault_context tool with vaults v1+v2 (see knowledge-search.test.ts helpers) ...
    // const out = await tool.handler({ vault: "v1", query: "kubernetes", token_budget: 4000, k: 30, include_work: false, include_lessons: true }, ctxFor(db, "v1"));
    // expect(out.syntheses).toEqual([]);
  });
});
```

> Concretize the `// ...` lines by copying the exact deps + `ctx` construction from `knowledge-search.test.ts` (same directory) — that file already builds `vault_context` and an ACL-bearing `ctx`. Do not invent new helper shapes.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/vault-context-syntheses-scope.test.ts`
Expected: FAIL — the `v2` synthesis row leaks into the `v1` response.

- [ ] **Step 3: Add the vault predicate**

In `packages/server/src/tools/m7/knowledge-tools.ts`, change the syntheses SELECT (currently lines 433-437) to scope by vault and bind `v.id` first:

```ts
          const rows = ctx.db
            .prepare(
              `SELECT iso_year, iso_week, generated_at, patterns FROM syntheses
               WHERE vault_id = ? AND (${like}) ORDER BY generated_at DESC LIMIT 2`,
            )
            .all(v.id, ...params) as Array<{
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bunx vitest run test/vault-context-syntheses-scope.test.ts test/knowledge-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/m7/knowledge-tools.ts packages/server/test/vault-context-syntheses-scope.test.ts
git commit -s -m "feat(THE-563): vault_context syntheses leg filters by vault_id

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: THE-564 — all-source ACL on `openContradictionsForPaths`

**Files:**
- Modify: `packages/server/src/tools/m7/knowledge-tools.ts:222-244` (`openContradictionsForPaths`), `:416-419` (`vault_context` caller), `:1082` (`list_contradictions` caller)
- Test: update `packages/server/test/list-contradictions.test.ts`

**Interfaces:**
- Consumes: `readableRel(ctx.acl, rel)` from `../../vault/acl-read-filter` (already imported).
- Produces: `openContradictionsForPaths(db, vaultId, paths, isReadable)` — filters `WHERE vault_id = ?` (563 gate) and drops any row where `!isReadable(source_path) || !isReadable(conflict_path)` (564 gate).

- [ ] **Step 1: Write the failing test**

In `packages/server/test/list-contradictions.test.ts`, update the inline `contradictions` DDL to the migrated shape (as in Task 2), insert a row whose `source_path` is readable but `conflict_path` is under a folder the caller cannot read, and assert `list_contradictions` omits it:

```ts
it("drops a contradiction whose conflict-side note is unreadable (THE-564)", async () => {
  // ACL grants read on "notes/" but not "private/". Row: source in notes/, conflict in private/.
  db.prepare(
    "INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, judge_verdict, status, detected_at) VALUES ('x', 'v1', 'sc', 'notes/a.md', 'cc', 'private/b.md', 's1', 's2', 'tension', 'open', 0)",
  ).run();
  const out = await tool.handler({ vault: "v1", paths: ["notes/a.md"] }, ctxWithAcl(readableNotesOnly));
  expect(out.contradictions).toEqual([]);
});
```

> Use this test file's existing tool-build + `ctx` helpers; `readableNotesOnly` is a `FolderAcl` granting `read` on `notes/**` only — mirror how other tests in the dir construct a restricted `ctx.acl`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/list-contradictions.test.ts`
Expected: FAIL — the `private/b.md` row is returned (only `source_path` was checked via `pathAcl`).

- [ ] **Step 3: Change the helper signature and both callers**

In `packages/server/src/tools/m7/knowledge-tools.ts`, replace `openContradictionsForPaths` (lines 222-244) with:

```ts
/** Open contradictions whose source or conflict note is in `paths` (THE-309), scoped to `vaultId`
 *  (THE-563) and re-authorized against the caller ACL (THE-564): a row is returned only if BOTH
 *  contributing sources remain readable — the opposite side of a matched pair may be outside the
 *  caller's set. Empty when the plane table is absent. */
export function openContradictionsForPaths(
  db: Database,
  vaultId: string,
  paths: string[],
  isReadable: (rel: string) => boolean,
): ContradictionContext[] {
  if (paths.length === 0 || !tableExists(db, "contradictions")) return [];
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, source_path, conflict_path, judge_verdict, judge_rationale FROM contradictions
       WHERE status = 'open' AND vault_id = ? AND (source_path IN (${placeholders}) OR conflict_path IN (${placeholders}))`,
    )
    .all(vaultId, ...paths, ...paths) as Array<{
    id: string;
    source_path: string;
    conflict_path: string;
    judge_verdict: string;
    judge_rationale: string | null;
  }>;
  return rows
    .filter((r) => isReadable(r.source_path) && isReadable(r.conflict_path))
    .map((r) => ({
      id: r.id,
      source_path: r.source_path,
      conflict_path: r.conflict_path,
      judge_verdict: r.judge_verdict,
      judge_rationale: r.judge_rationale ?? "",
    }));
}
```

Update the `vault_context` caller (lines 416-419):

```ts
        const contradictions = openContradictionsForPaths(
          ctx.db,
          v.id,
          notes.map((n) => n.path),
          (rel) => readableRel(ctx.acl, rel),
        ).slice(0, 5);
```

Update the `list_contradictions` caller (line 1082):

```ts
        const contradictions = openContradictionsForPaths(ctx.db, v.id, paths, (rel) =>
          readableRel(ctx.acl, rel),
        );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bunx vitest run test/list-contradictions.test.ts test/knowledge-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/m7/knowledge-tools.ts packages/server/test/list-contradictions.test.ts
git commit -s -m "feat(THE-564): re-authorize both contributing sources of a contradiction before return

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: THE-564 — challenge/model-egress path is covered

**Files:**
- Test: `packages/server/test/knowledge-challenge-evidence.test.ts` (add an egress-filter assertion)

**Interfaces:**
- Consumes: `knowledge_challenge` composes open contradictions into the gateway prompt via `openContradictionsForPaths` (now filtered by Task 5).

This task adds no production code — it proves Task 5's filter covers the model-egress path. If the assertion fails, the fix belongs in Task 5 (the challenge path must call the same filtered helper), not here.

- [ ] **Step 1: Write the failing/guard test**

In `packages/server/test/knowledge-challenge-evidence.test.ts`, add a test that seeds a contradiction whose conflict-side note is unreadable, runs `knowledge_challenge` with a captured/mock gateway `judge` role, and asserts the composed prompt text passed to the gateway contains neither the unreadable `conflict_path` nor its rationale:

```ts
it("never sends an unreadable contradiction source to the model (THE-564)", async () => {
  const seen: string[] = [];
  const roles = mockRolesCapturing((userMsg) => seen.push(userMsg)); // capture the judge prompt
  // seed contradiction: source readable (notes/a.md), conflict unreadable (private/b.md)
  // run knowledge_challenge over notes/a.md with an ACL granting only notes/**
  // ...build tool + restricted ctx as in the sibling tests...
  expect(seen.join("\n")).not.toContain("private/b.md");
});
```

> Reuse this file's existing challenge tool + gateway-mock construction. If it lacks a prompt-capturing mock, extend the existing `GatewayRoles` mock to push the user message into an array before returning its canned verdict.

- [ ] **Step 2: Run test**

Run: `cd packages/server && bunx vitest run test/knowledge-challenge-evidence.test.ts`
Expected: PASS (Task 5 already routes the challenge path through the filtered helper). If it FAILS, the challenge composition does not use `openContradictionsForPaths` — trace it and route it through the filtered helper, then re-run.

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/knowledge-challenge-evidence.test.ts
git commit -s -m "test(THE-564): assert unreadable contradiction source never reaches the model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: audit #9 — migration completeness gate

**Files:**
- Create: `packages/server/src/db/migration-manifest.ts`
- Modify: `packages/server/src/db/provision.ts` (build `CACHE_MIGRATIONS` from the manifest)
- Modify: `packages/server/src/cli.ts` (build the experiential chain from the manifest)
- Test: `packages/server/test/migrations-manifest.test.ts`

**Interfaces:**
- Produces: `CACHE_MIGRATION_FILES: readonly string[]` and `EXPERIENTIAL_MIGRATION_FILES: readonly string[]` — the single source of truth for which `.sql` file belongs to which chain. `versionOf(file)` = first two `_`-segments.

- [ ] **Step 1: Confirm the experiential consts are only used in the chain array**

Run: `cd packages/server && grep -n "experientialInitMigrationSql\|experientialOutcomeMigrationSql\|experientialAgentEpisodesMigrationSql\|preferenceProfileMigrationSql\|accessViewsMigrationSql\|forgetLogMigrationSql\|activationWatermarkMigrationSql" src/cli.ts`
Expected: each name appears only at its `readFileSync` declaration and inside the `experientialMigrations` array. (If any is referenced elsewhere, keep that declaration and only replace the array construction in Step 4.)

- [ ] **Step 2: Write the failing test**

Create `packages/server/test/migrations-manifest.test.ts`:

```ts
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CACHE_MIGRATION_FILES,
  EXPERIENTIAL_MIGRATION_FILES,
} from "../src/db/migration-manifest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../src/migrations/", import.meta.url));

describe("migration manifest completeness (audit #9)", () => {
  const onDisk = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const registered = [...CACHE_MIGRATION_FILES, ...EXPERIENTIAL_MIGRATION_FILES].sort();

  it("every .sql file on disk is registered in exactly one chain", () => {
    expect(registered).toEqual(onDisk);
  });

  it("the two chains are disjoint", () => {
    const overlap = CACHE_MIGRATION_FILES.filter((f) =>
      (EXPERIENTIAL_MIGRATION_FILES as readonly string[]).includes(f),
    );
    expect(overlap).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/migrations-manifest.test.ts`
Expected: FAIL — `../src/db/migration-manifest` does not exist.

- [ ] **Step 4: Create the manifest and rewire both chains**

Create `packages/server/src/db/migration-manifest.ts`:

```ts
// Single source of truth for which migration file belongs to which chain. The completeness test
// (audit #9) asserts every migrations/*.sql appears in exactly one of these arrays, so a new SQL
// file that is not wired into a chain fails CI instead of silently never running. Order is
// application order — append, never reorder.

/** cache.db chain (db/provision.ts). */
export const CACHE_MIGRATION_FILES = [
  "20260519_001_initial.sql",
  "20260519_002_entity_unique.sql",
  "20260626_001_vault_edges.sql",
  "20260626_002_plane.sql",
  "20260702_001_notes.sql",
  "20260703_001_vault_edges_vault_id.sql",
  "20260709_001_snapshots.sql",
  "20260713_001_vault_edges_derived.sql",
  "20260719_001_chunks_body_sha.sql",
  "20260722_001_chunks_dedup_index.sql",
  "20260723_001_vault_generation.sql",
  "20260723_002_jobs.sql",
  "20260724_001_plane_vault_id.sql",
] as const;

/** experiential.db chain (cli.ts). */
export const EXPERIENTIAL_MIGRATION_FILES = [
  "20260626_001_experiential_init.sql",
  "20260711_001_experiential_outcome.sql",
  "20260711_002_agent_episodes.sql",
  "20260712_001_preference_profile.sql",
  "20260712_002_access_views.sql",
  "20260712_003_forget_log.sql",
  "20260723_001_activation_watermark.sql",
] as const;

/** Registered migration version = the first two underscore-delimited segments of the filename. */
export function versionOf(file: string): string {
  return file.split("_").slice(0, 2).join("_");
}
```

In `packages/server/src/db/provision.ts`, replace the hand-written `CACHE_MIGRATIONS` array with one built from the manifest (keep the `sql()` loader and the `MIGRATIONS_DIR` resolution above it unchanged):

```ts
import { CACHE_MIGRATION_FILES, versionOf } from "./migration-manifest";

// ... existing MIGRATIONS_DIR + sql() unchanged ...

export const CACHE_MIGRATIONS: Migration[] = CACHE_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: sql(file),
}));
```

In `packages/server/src/cli.ts`, replace the seven `readFileSync` declarations **and** the `experientialMigrations` array (only if Step 1 confirmed the consts are unused elsewhere) with a manifest-driven build. Add the import near the other db imports and construct the chain where `experientialMigrations` is defined:

```ts
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "./db/migration-manifest";

const experientialMigrations = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: readFileSync(fileURLToPath(new URL(`./migrations/${file}`, import.meta.url)), "utf8"),
}));
```

Delete the now-unused `experientialInitMigrationSql` … `activationWatermarkMigrationSql` consts.

- [ ] **Step 5: Run the manifest test + the full suite**

Run: `cd packages/server && bunx vitest run test/migrations-manifest.test.ts`
Expected: PASS (2 tests).
Run: `cd packages/server && bun run test` (full suite — the chain refactor must not change applied schema)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/migration-manifest.ts packages/server/src/db/provision.ts packages/server/src/cli.ts packages/server/test/migrations-manifest.test.ts
git commit -s -m "feat(audit-#9): single migration manifest + completeness gate over both chains

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: audit P1.6 (deep half) — `reflect.persist` governed write

**Files:**
- Create: `packages/server/src/vault/persist-note.ts`
- Modify: `packages/server/src/tools/m7/knowledge-tools.ts` (`M7Deps` + `reflect.persist` block at `:713-746`)
- Modify: `packages/server/src/cli.ts` (`registerM7Tools` deps: add `snapshots` + `reindex`)
- Modify: `packages/server/src/tools/m1/notes-tools.ts:455-458` (`write_note` reuses the helper)
- Test: `packages/server/test/reflect-persist-governed.test.ts`

**Interfaces:**
- Produces: `persistGovernedNote(db, deps, params)` where `deps: { snapshots?: { enabled: boolean; retention: number }; reindex?: (vaultId, path, content) => void; now?: () => number }` and `params: { vaultId: string; root: string; rel: string; content: string; op: string; createDirs: boolean }`. Sequence: snapshot prior (if the note exists) → `writeNoteAtomic` → `reindex`.
- Consumes: `captureSnapshot`, `writeNoteAtomic`, `noteExists`, `readNote` from `./snapshots` / `./notes-io`; `resolveVaultPath` from `./paths`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/reflect-persist-governed.test.ts`. Build the `reflect` tool with an M7Deps carrying a `reindex` spy and `snapshots: { enabled: true, retention: 5 }`, call it twice same-day with `persist: true` and a `write:notes` grant, and assert (a) `reindex` was called with `(vaultId, rel, content)` and (b) the second call captured a snapshot of the first (row present in `snapshot_index`/`snapshot_blobs`):

```ts
it("reflect.persist snapshots the prior note and reindexes (THE P1.6)", async () => {
  const reindexed: Array<[string, string, string]> = [];
  // ...build reflect tool with deps.reindex = (v, p, c) => reindexed.push([v, p, c]),
  //    deps.snapshots = { enabled: true, retention: 5 }, a mock synthesize role...
  await tool.handler({ vault: "v1", query: "same query", persist: true, mode: "synthesis" }, ctxWrite);
  await tool.handler({ vault: "v1", query: "same query", persist: true, mode: "synthesis" }, ctxWrite);
  expect(reindexed.length).toBeGreaterThanOrEqual(2);
  const snaps = db.prepare("SELECT COUNT(*) AS n FROM snapshot_blobs").get() as { n: number };
  expect(snaps.n).toBeGreaterThanOrEqual(1);
});
```

> Copy the reflect-tool build + write-scoped `ctx` (grantedScopes includes `write:notes`, an ACL granting write under the memory folder) from the existing reflect test in this directory; provision the cache.db with `runMigrations(db, CACHE_MIGRATIONS)` so `snapshot_blobs`/`snapshot_index` exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bunx vitest run test/reflect-persist-governed.test.ts`
Expected: FAIL — raw `writeFileSync` neither snapshots nor reindexes; `reindexed` is empty and `snapshot_blobs` is empty.

- [ ] **Step 3: Create the governed-write helper**

Create `packages/server/src/vault/persist-note.ts`:

```ts
// THE-562 P1.6: the governed note-write sequence, shared by write_note and reflect.persist so the
// two cannot drift. A raw writeFileSync bypasses the snapshot (no recovery point on overwrite), the
// atomic tmp+rename (a reader can catch a torn file), and index-on-write + generation bump (the note
// is never indexed and stale caches are not invalidated). Route derived-note writes through here.
import type { Database } from "../db/types";
import { noteExists, readNote, writeNoteAtomic } from "./notes-io";
import { resolveVaultPath } from "./paths";
import { captureSnapshot } from "./snapshots";

export interface GovernedWriteDeps {
  snapshots?: { enabled: boolean; retention: number };
  reindex?: (vaultId: string, path: string, content: string) => void;
  now?: () => number;
}

export interface GovernedWriteParams {
  vaultId: string;
  root: string;
  rel: string;
  content: string;
  op: string;
  createDirs: boolean;
}

export function persistGovernedNote(
  db: Database,
  deps: GovernedWriteDeps,
  params: GovernedWriteParams,
): void {
  const abs = resolveVaultPath(params.root, params.rel);
  const ex = noteExists(abs);
  if (ex.exists) {
    const prev = readNote(abs);
    captureSnapshot(db, deps.snapshots, params.vaultId, params.rel, prev.raw, params.op, deps.now ?? Date.now);
  }
  writeNoteAtomic(abs, params.content, params.createDirs);
  deps.reindex?.(params.vaultId, params.rel, params.content);
}
```

- [ ] **Step 4: Add `snapshots`/`reindex` to `M7Deps` and route `reflect.persist` through the helper**

In `packages/server/src/tools/m7/knowledge-tools.ts`, add to the `M7Deps` interface (near `prewarmDir`):

```ts
  /** THE-562 P1.6: governed-write handles so reflect.persist snapshots + reindexes like write_note. */
  snapshots?: { enabled: boolean; retention: number };
  reindex?: (vaultId: string, path: string, content: string) => void;
```

Add the import near the other vault imports:

```ts
import { persistGovernedNote } from "../../vault/persist-note";
```

Replace the raw-write block (lines 729-745: `resolveVaultPath` + `mkdirSync` + `writeFileSync`) with a `content` build + governed write, keeping the `enforcePathAcl` at line 728:

```ts
          enforcePathAcl(ctx.acl, "write", rel, v.root);
          const content = [
            "---",
            `generated_at: ${new Date(nowMs).toISOString()}`,
            `source_model: ${res.model}`,
            `query: ${JSON.stringify(input.query)}`,
            `source_chunks: ${JSON.stringify(results.slice(0, 20).map((r) => r.chunk_id))}`,
            `source_paths: ${JSON.stringify([...new Set(results.slice(0, 20).map((r) => r.path))])}`,
            "---",
            "",
            res.text,
            "",
          ].join("\n");
          persistGovernedNote(
            ctx.db,
            { snapshots: deps.snapshots, reindex: deps.reindex, now: ctx.now ?? Date.now },
            { vaultId: v.id, root: v.root, rel, content, op: "reflect_persist", createDirs: true },
          );
          persisted = { path: rel };
```

Remove the now-unused `mkdirSync`/`writeFileSync`/`dirname` imports if nothing else in the file uses them (grep first: `grep -n "mkdirSync\|writeFileSync\|dirname(" packages/server/src/tools/m7/knowledge-tools.ts` — the prewarm write at ~line 561 may still use one; keep whatever is still referenced).

- [ ] **Step 5: Wire the deps in `cli.ts`**

In `packages/server/src/cli.ts`, in the `registerM7Tools(registry, { ... })` call (around line 1321), add:

```ts
    // THE-562 P1.6: reflect.persist writes through the governed path (snapshot + index-on-write).
    snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
    reindex: reindexHook,
```

- [ ] **Step 6: Run the reflect test to verify it passes**

Run: `cd packages/server && bunx vitest run test/reflect-persist-governed.test.ts`
Expected: PASS.

- [ ] **Step 7: Refactor `write_note` to reuse the helper (no behaviour change)**

In `packages/server/src/tools/m1/notes-tools.ts`, replace lines 455-458 (the `if (prevRaw !== null) captureSnapshot(...)` + `writeNoteAtomic(...)` + `deps.reindex?.(...)` sequence) with:

```ts
        persistGovernedNote(
          ctx.db,
          { snapshots: deps.snapshots, reindex: deps.reindex, now: ctx.now },
          {
            vaultId: v.id,
            root: v.root,
            rel,
            content: input.content,
            op: "write_note",
            createDirs: input.options.create_dirs,
          },
        );
```

Add the import: `import { persistGovernedNote } from "../../vault/persist-note";`. Remove the direct `captureSnapshot` import from this file only if no other handler in it still calls `captureSnapshot` (grep: `grep -n "captureSnapshot" packages/server/src/tools/m1/notes-tools.ts` — `append_note`/`patch_note`/`delete_note`/`rename` still use it directly, so **keep** the import).

- [ ] **Step 8: Run the write-note + notes suites to verify no regression**

Run: `cd packages/server && bunx vitest run -t "write_note"` then `cd packages/server && bun run test` (full suite)
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/vault/persist-note.ts packages/server/src/tools/m7/knowledge-tools.ts packages/server/src/cli.ts packages/server/src/tools/m1/notes-tools.ts packages/server/test/reflect-persist-governed.test.ts
git commit -s -m "feat(audit-P1.6): route reflect.persist through the governed note-write service

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full gate + PR

**Files:** none (verification only)

- [ ] **Step 1: Biome + typecheck + full server suite**

Run from repo root: `bun run lint` (biome) and the package typechecks + `cd packages/server && bun run test`.
Expected: all green. Fix any biome/tsc findings in the touched files before proceeding.

- [ ] **Step 2: Push the branch and open the PR**

```bash
git push -u origin <branch>
gh pr create --base main --title "THE-563/564: derived-plane vault isolation + all-source ACL (+#9, P1.6)" --body "$(cat <<'EOF'
Closes THE-563, THE-564. Folds THE-562 tail items #9 (migration completeness gate) and P1.6 deep-half (reflect.persist governed write).

Spec: docs/superpowers/specs/2026-07-24-the-563-564-derived-plane-isolation-design.md

- THE-563: contradictions/syntheses gain vault_id (purge migration, THE-310 precedent); synthesis runs per vault; readers filter by vault.
- THE-564: openContradictionsForPaths re-authorizes BOTH contributing sources against the caller ACL before return/model-egress (THE-543 pattern).
- #9: single migration manifest + CI bijection gate over both chains.
- P1.6: reflect.persist routes through the governed snapshot→atomic→reindex helper, shared with write_note.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Confirm CI triggered with a non-zero check count**

Run: `gh pr checks <pr#>` (after ~1 min)
Expected: a non-empty list of checks, none failing. If zero checks appear, close/reopen the PR to re-trigger workflows. Merge only once green.

---

## Self-Review

**Spec coverage:**
- THE-563 migration (purge + reshape) → Task 1. ✓
- THE-563 contradiction writer vault_id + id hash → Task 2. ✓
- THE-563 per-vault synthesis → Task 3. ✓
- THE-563 reader vault predicates: syntheses → Task 4; contradictions → folded into Task 5's `WHERE vault_id = ?`. ✓
- THE-564 all-source ACL on `openContradictionsForPaths` + both callers → Task 5. ✓
- THE-564 challenge/model-egress coverage → Task 6. ✓
- Syntheses boundary (vault-predicate only) → honored: Task 4 gates syntheses by vault; no per-path claim made. ✓
- #9 manifest gate → Task 7. ✓
- P1.6 governed write (helper + reflect + write_note reuse) → Task 8. ✓
- Delivery: worktree + ordered DCO commits + one PR + green gate → Tasks 1-9. ✓

**Placeholder scan:** The `// ...` markers in Tasks 4/5/6/8 are explicitly bounded — each is followed by a note instructing the engineer to copy the exact deps/ctx construction from a named sibling test file (`knowledge-search.test.ts`, `list-contradictions.test.ts`, the reflect test). This is deliberate reuse of existing test scaffolding, not an unspecified requirement; the assertions and production code are fully given.

**Type consistency:** `openContradictionsForPaths(db, vaultId, paths, isReadable)` — same 4-arg shape at both callers (Task 5). `persistGovernedNote(db, deps, params)` — same shape in `reflect.persist` (Task 8 Step 4) and `write_note` (Task 8 Step 7). `versionOf(file)` defined once (Task 7) and used in provision.ts + cli.ts. `CACHE_MIGRATIONS` shape (`{ version, sql }`) unchanged for `runMigrations` consumers.

**Note on test-file edits:** several existing tests provision plane tables inline with the OLD schema. Tasks 2/3/5 each update the specific file's inline DDL to the migrated shape as part of that task — the migrated DDL is given verbatim so no guesswork is needed.
