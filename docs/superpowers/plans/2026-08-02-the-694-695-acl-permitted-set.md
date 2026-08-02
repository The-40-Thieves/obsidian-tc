# ACL Permitted-Path Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the read-ACL predicate visible to SQLite so graph expansion and BM25 stop computing aggregates over content the caller cannot see, and close the router's timing oracle by not probing at all when the caller is restricted.

**Architecture:** One persistent, path-keyed permitted set in `cache.db`, keyed by `(aclFingerprint, vaultId)` and stamped with the vault `generation`, built lazily and evicted LRU. Three consumers use it differently: the router stops probing, BM25 joins it and drops its over-fetch, and the graph walk joins it inside the recursive CTE behind a config flag so the recall change can be evaluated.

**Tech Stack:** TypeScript 7, Bun 1.3.14 (SQLite 3.53.0), Vitest 4, Biome 2.5, SQLite with `WITHOUT ROWID` + `ON DELETE CASCADE`.

**Spec:** `docs/superpowers/specs/2026-08-02-the-694-695-acl-permitted-set-design.md`

## Global Constraints

- **Migrations are append-only, hand-registered, checksum-pinned.** Add the `.sql`, append it to `packages/server/src/db/migration-manifest.ts`, then run `bun run migrations:embed`. Editing a shipped migration is a hard startup error.
- **Never pipe a gate through `tail`/`head`** — `$?` reports the pipe. Redirect to a log, check `$?` separately.
- **Every commit needs DCO sign-off:** `git commit -s`.
- **`bun run map` counts TRACKED files** — run it *after* `git add`, then `git add` again.
- **Don't run the full suite locally.** Targeted Vitest only, through `../../scripts/with-host-budget.sh`. Push and let CI run the rest.
- **Before opening the PR, use the `gates` skill** — it enumerates gates from the workflows rather than from memory.
- **`readableRel` must receive the path exactly as the DB stores it.** 35 live paths contain non-ASCII; `readableRel` NFC-normalizes internally to decide, but the stored join key must be byte-identical to `chunks.path`.
- **Branch:** `mislam2/the-694-695-acl-permitted-set` (already created, spec already committed).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/server/src/migrations/20260802_001_acl_path_sets.sql` | **Create.** The two tables. |
| `packages/server/src/db/migration-manifest.ts` | **Modify.** Append the migration filename to `CACHE_MIGRATION_FILES`. |
| `packages/server/src/db/migrations-embedded.ts` | **Regenerate.** Never hand-edit. |
| `packages/server/src/search/acl_path_set.ts` | **Create.** Build, read and evict the set. The only file that writes these tables. |
| `packages/server/src/search/router.ts` | **Modify.** Gate the rare-term probe on unrestricted read; delete the paged scan. |
| `packages/server/src/search/chunk_fts.ts` | **Modify.** `bm25Chunks` joins the set, over-fetch deleted. |
| `packages/server/src/search/graph_expand.ts` | **Modify.** Optional ACL join inside the recursive CTE. |
| `packages/server/src/search/graph_search_stages/types.ts` | **Modify.** Add the `aclWalkFilter` option. |
| `packages/server/src/search/graph_search_stages/graph_expansion.ts` | **Modify.** Thread the set id into the walk. |
| `packages/server/test/acl-path-set.test.ts` | **Create.** Module tests incl. the rowid-reuse regression. |

---

### Task 1: The migration

**Files:**
- Create: `packages/server/src/migrations/20260802_001_acl_path_sets.sql`
- Modify: `packages/server/src/db/migration-manifest.ts`
- Regenerate: `packages/server/src/db/migrations-embedded.ts`
- Test: `packages/server/test/acl-path-set.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `acl_path_sets(set_id, acl_fingerprint, vault_id, generation, built_at, path_count)` and `acl_path_members(set_id, path)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/acl-path-set.test.ts`:

```ts
// THE-694/695 — the permitted-path set. Path-keyed, not chunk-keyed: readableRel is a pure
// function of the path, so the live vault needs 1,146 rows rather than 13,486.
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

const read = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${file}`, import.meta.url)), "utf8");
const CACHE_CHAIN = CACHE_MIGRATION_FILES.map((file) => ({ version: versionOf(file), sql: read(file) }));

function cacheDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, CACHE_CHAIN);
  return db;
}

describe("acl_path_sets schema", () => {
  it("provisions both tables through the production migration chain", () => {
    const db = cacheDb();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'acl_path_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(names.map((n) => n.name)).toStrictEqual(["acl_path_members", "acl_path_sets"]);
    db.close?.();
  });

  it("keys a set by (fingerprint, vault) so a regenerated set replaces rather than accumulates", () => {
    const db = cacheDb();
    db.prepare(
      "INSERT INTO acl_path_sets (acl_fingerprint, vault_id, generation, built_at, path_count) VALUES ('fp','main',1,1,1)",
    ).run();
    // A second row for the same (fingerprint, vault) must be refused — growth is bounded by
    // distinct fingerprints, never by generations.
    expect(() =>
      db
        .prepare(
          "INSERT INTO acl_path_sets (acl_fingerprint, vault_id, generation, built_at, path_count) VALUES ('fp','main',2,2,1)",
        )
        .run(),
    ).toThrow();
    db.close?.();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/acl-path-set.test.ts > /tmp/acl-red1.log 2>&1; echo "exit=$?"
```

Expected: FAIL — `["acl_path_members","acl_path_sets"]` vs `[]`, because the tables do not exist.

- [ ] **Step 3: Write the migration**

Create `packages/server/src/migrations/20260802_001_acl_path_sets.sql`:

```sql
-- 20260802_001_acl_path_sets.sql
-- THE-694/695: the read-ACL predicate, made visible to SQLite.
--
-- PATH-keyed, not chunk-keyed: readableRel is a pure function of the path, so this holds 1,146 rows
-- on the live vault rather than 13,486, and still serves chunks (join path), vault_edges (join
-- source_path/target_path) and notes (join path).
--
-- The UNIQUE key deliberately EXCLUDES generation: a regenerated set replaces its predecessor in
-- place, so growth is bounded by distinct ACL fingerprints rather than by index generations, which
-- is what makes an LRU cap meaningful.
CREATE TABLE IF NOT EXISTS acl_path_sets (
  set_id          INTEGER PRIMARY KEY,
  acl_fingerprint TEXT    NOT NULL,
  vault_id        TEXT    NOT NULL,
  generation      INTEGER NOT NULL,
  built_at        INTEGER NOT NULL,
  path_count      INTEGER NOT NULL,
  UNIQUE (acl_fingerprint, vault_id)
);

-- The surrogate set_id exists for ROW SIZE. WITHOUT ROWID wants average rows under 1/20 of a page;
-- page_size is 4096, so the budget is 204.8 bytes. Repeating the 64-char SHA-256 fingerprint on
-- every member costs 165 bytes at the longest live path (81% of budget) and re-stores 71.6 KiB of
-- identical hash. Interning gives 104 bytes worst case.
--
-- ON DELETE CASCADE is the PRIMARY safety control, not tidiness. Without AUTOINCREMENT, SQLite
-- reuses a deleted rowid when the deleted row held the largest one — which is exactly what LRU
-- eviction does when the cap binds. Reproduced with foreign_keys=OFF: evict set 2 (the max), its
-- members are stranded, and the next caller is allocated the REUSED id 2 and reads them. The
-- eviction code ALSO deletes members explicitly, because foreign_keys is per-connection runtime
-- state and correctness must not depend on a PRAGMA.
CREATE TABLE IF NOT EXISTS acl_path_members (
  set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE,
  path   TEXT    NOT NULL,
  PRIMARY KEY (set_id, path)
) WITHOUT ROWID;
```

- [ ] **Step 4: Register and embed it**

Append `"20260802_001_acl_path_sets.sql",` to the end of the `CACHE_MIGRATION_FILES` array in `packages/server/src/db/migration-manifest.ts` (currently ends with `"20260728_002_jobs_outcome.sql"`), then:

```bash
cd /home/ubuntu/obsidian-tc && bun run migrations:embed
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/acl-path-set.test.ts > /tmp/acl-green1.log 2>&1; echo "exit=$?"
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Verify the embed gate agrees**

```bash
cd /home/ubuntu/obsidian-tc && bun run migrations:embed:check > /tmp/embed-check.log 2>&1; echo "exit=$?"
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/obsidian-tc
git add packages/server/src/migrations/20260802_001_acl_path_sets.sql \
        packages/server/src/db/migration-manifest.ts \
        packages/server/src/db/migrations-embedded.ts \
        packages/server/test/acl-path-set.test.ts
git commit -s -m "feat(acl): permitted-path set tables (THE-694, THE-695)"
```

---

### Task 2: The `acl_path_set` module

**Files:**
- Create: `packages/server/src/search/acl_path_set.ts`
- Test: `packages/server/test/acl-path-set.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's tables.
- Produces:
  - `hasAclPathSets(db: Database): boolean`
  - `ensureAclPathSet(db: Database, opts: EnsureAclPathSetOpts): number | null` — returns `set_id`, or `null` when the substrate is unavailable or the set would be empty. Callers that get `null` keep their existing JS filter.
  - `evictAclPathSets(db: Database, maxSets: number): number` — returns the number of sets removed.
  - `DEFAULT_MAX_SETS = 32`

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/acl-path-set.test.ts`:

```ts
import { DEFAULT_MAX_SETS, ensureAclPathSet, evictAclPathSets } from "../src/search/acl_path_set";

const members = (db: Database, setId: number): string[] =>
  (db.prepare("SELECT path FROM acl_path_members WHERE set_id = ? ORDER BY path").all(setId) as Array<{
    path: string;
  }>).map((r) => r.path);

const build = (db: Database, over: Partial<Parameters<typeof ensureAclPathSet>[1]> = {}) =>
  ensureAclPathSet(db, {
    vaultId: "main",
    aclFingerprint: "fp-a",
    generation: 1,
    allPaths: () => ["02-projects/a.md", "09-secret/b.md", "02-projects/c.md"],
    isReadable: (p) => p.startsWith("02-projects/"),
    nowMs: 1000,
    ...over,
  });

describe("ensureAclPathSet", () => {
  it("materializes only the readable paths", () => {
    const db = cacheDb();
    const id = build(db);
    expect(id).not.toBeNull();
    expect(members(db, id as number)).toStrictEqual(["02-projects/a.md", "02-projects/c.md"]);
    db.close?.();
  });

  it("reuses the set when the generation is unchanged", () => {
    const db = cacheDb();
    const first = build(db);
    let calls = 0;
    const second = build(db, {
      allPaths: () => {
        calls++;
        return [];
      },
    });
    expect(second).toBe(first);
    expect(calls).toBe(0); // a hit must not touch the universe at all
    db.close?.();
  });

  it("rebuilds in place on a generation bump, keeping the same set_id", () => {
    const db = cacheDb();
    const first = build(db);
    const second = build(db, {
      generation: 2,
      allPaths: () => ["02-projects/a.md", "02-projects/new.md"],
      isReadable: () => true,
    });
    expect(second).toBe(first); // same surrogate id — members are replaced, not accumulated
    expect(members(db, second as number)).toStrictEqual(["02-projects/a.md", "02-projects/new.md"]);
    db.close?.();
  });

  it("REFUSES to persist an empty set over a non-empty universe", () => {
    const db = cacheDb();
    // The trap this guards: a broken universe query materializes an empty set, every query then
    // filters to nothing, and the system looks perfectly healthy while returning zero results.
    const id = build(db, { isReadable: () => false });
    expect(id).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM acl_path_sets").get()).toMatchObject({ n: 0 });
    db.close?.();
  });

  it("returns null rather than throwing when the tables are absent", () => {
    const db = openMemoryDb(); // no migrations at all
    expect(build(db)).toBeNull();
    db.close?.();
  });

  it("isolates fingerprints over the same vault", () => {
    const db = cacheDb();
    const a = build(db, { aclFingerprint: "fp-a", isReadable: (p) => p.startsWith("02-projects/") });
    const b = build(db, { aclFingerprint: "fp-b", isReadable: (p) => p.startsWith("09-secret/") });
    expect(a).not.toBe(b);
    expect(members(db, a as number)).toStrictEqual(["02-projects/a.md", "02-projects/c.md"]);
    expect(members(db, b as number)).toStrictEqual(["09-secret/b.md"]);
    db.close?.();
  });
});

describe("evictAclPathSets — the rowid-reuse leak", () => {
  it("leaves no member reachable under a REUSED set_id, without relying on the FK pragma", () => {
    const db = cacheDb();
    // The failing condition this test exists for. foreign_keys is per-connection runtime state, so
    // a raw connection would silently lose the cascade — eviction must be correct without it.
    db.exec("PRAGMA foreign_keys = OFF");

    // `a` is built LAST in wall-clock terms but SECOND in insertion order, so `b` holds the larger
    // set_id while being the least-recently-built. Evicting to a cap of 1 therefore drops the row
    // with the MAXIMUM rowid — the precise condition under which SQLite reuses an id.
    const b = build(db, {
      aclFingerprint: "fp-b",
      nowMs: 1000,
      allPaths: () => ["09-secret/b.md"],
      isReadable: () => true,
    }) as number;
    const a = build(db, { aclFingerprint: "fp-a", nowMs: 2000 }) as number;
    expect(b).toBeLessThan(a); // b was inserted first...

    // ...but a is newer, so the LRU drop takes b. Re-point the ids so the assertion is about the
    // max-rowid row specifically.
    const maxId = (db.prepare("SELECT MAX(set_id) AS m FROM acl_path_sets").get() as { m: number }).m;
    expect(evictAclPathSets(db, 1)).toBe(1);

    // Whichever row was dropped, no member may survive it — otherwise the next caller allocated a
    // reused id reads another principal's paths. Assert over BOTH ids so the test cannot pass by
    // accident of which one was evicted.
    expect(members(db, b)).toStrictEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM acl_path_members WHERE set_id NOT IN (SELECT set_id FROM acl_path_sets)").get(),
    ).toMatchObject({ n: 0 }); // zero orphans, by construction
    expect(maxId).toBeGreaterThan(0);
    db.close?.();
  });

  it("evicts least-recently-built sets beyond the cap, members first", () => {
    const db = cacheDb();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        build(db, {
          aclFingerprint: `fp-${i}`,
          nowMs: 1000 + i,
          allPaths: () => [`02-projects/${i}.md`],
          isReadable: () => true,
        }) as number,
      );
    }
    expect(evictAclPathSets(db, 2)).toBe(2);
    const left = (db.prepare("SELECT set_id FROM acl_path_sets ORDER BY set_id").all() as Array<{
      set_id: number;
    }>).map((r) => r.set_id);
    expect(left).toStrictEqual([ids[2], ids[3]]); // the two most recently built survive
    expect(members(db, ids[0] as number)).toStrictEqual([]);
    expect(members(db, ids[1] as number)).toStrictEqual([]);
    db.close?.();
  });

  it("exposes a default cap", () => {
    expect(DEFAULT_MAX_SETS).toBe(32);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/acl-path-set.test.ts > /tmp/acl-red2.log 2>&1; echo "exit=$?"
```

Expected: FAIL with `ensureAclPathSet is not a function` (feature missing, not a typo).

- [ ] **Step 3: Write the module**

Create `packages/server/src/search/acl_path_set.ts`:

```ts
// THE-694/695 — the read-ACL predicate, materialized so SQLite can join on it.
//
// Three retrieval paths compute an aggregate over the whole corpus and hand the result to a caller
// who can only see part of it. Fixing that needs the authorization boundary visible to SQL, which
// the cross-adapter Database interface cannot otherwise provide: bun:sqlite (what production runs)
// exposes no user-defined function registration at all, so a scalar predicate is not an option.
//
// The security property this rests on: for a fixed (fingerprint, path-string), readableRel is
// CONSTANT over time. Its only inputs are isDefaultDenied(path) — pure in the path — plus
// matchedPathGlob("read", path) and strictReadDefault, and aclFingerprint canonicalizes both. So a
// stale set can only ever MISS a readable path (recall loss); it can never hold a path that has
// since become unreadable, because that change moves the fingerprint and makes the old set
// unreachable rather than wrong.
import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";

/** Cap on stored sets. Growth is bounded by distinct ACL fingerprints, not by generations, so on a
 *  single-principal deployment this never binds — but the bound is real. */
export const DEFAULT_MAX_SETS = 32;

export interface EnsureAclPathSetOpts {
  vaultId: string;
  /** THE-496 aclFingerprint(config, grantedScopes) for THIS caller and vault. */
  aclFingerprint: string;
  /** THE-496 readGeneration(db, vaultId). 0 on a pre-migration db, which is safe: a never-bumping
   *  generation degrades this to build-once, it never widens the key. */
  generation: number;
  /** The path universe. Injected so this module never guesses which table defines it. */
  allPaths: () => string[];
  /** readableRel bound to this caller. MUST be passed the path exactly as the DB stores it. */
  isReadable: (rel: string) => boolean;
  nowMs: number;
  maxSets?: number;
}

/** True when the THE-694 tables exist (a pre-migration cache.db lacks them). */
export function hasAclPathSets(db: Database): boolean {
  return tableExists(db, "acl_path_sets");
}

/**
 * Return the set_id of a current permitted-path set for this caller, building it if needed.
 *
 * Returns null — never throws — when the substrate cannot serve the request: tables absent, handle
 * read-only (the eval harness and `doctor --probe` open stores they must not write), or the set
 * would be empty. Every caller treats null as "keep your existing JS filter", so a failure here
 * costs performance and exactness, never correctness.
 */
export function ensureAclPathSet(db: Database, opts: EnsureAclPathSetOpts): number | null {
  if (!hasAclPathSets(db)) return null;
  try {
    const existing = db
      .prepare(
        "SELECT set_id, generation FROM acl_path_sets WHERE acl_fingerprint = ? AND vault_id = ?",
      )
      .get(opts.aclFingerprint, opts.vaultId) as { set_id: number; generation: number } | undefined;
    // A hit must not touch the universe — that read is the expensive half.
    if (existing && existing.generation === opts.generation) return existing.set_id;

    const universe = opts.allPaths();
    if (universe.length === 0) return null;
    const readable = universe.filter((p) => opts.isReadable(p));
    // EMPTY-SET FLOOR. A broken universe query, or a caller who genuinely reads nothing, must not
    // persist a set that silently filters every query to zero while looking healthy. Same shape as
    // this repo's rule that a gate scanning zero files reports success.
    if (readable.length === 0) return null;

    db.exec("BEGIN IMMEDIATE");
    try {
      // UPSERT, never INSERT OR REPLACE: REPLACE is DELETE + INSERT and would strand every member
      // under a new set_id.
      db.prepare(
        `INSERT INTO acl_path_sets (acl_fingerprint, vault_id, generation, built_at, path_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(acl_fingerprint, vault_id) DO UPDATE SET
           generation = excluded.generation,
           built_at   = excluded.built_at,
           path_count = excluded.path_count`,
      ).run(opts.aclFingerprint, opts.vaultId, opts.generation, opts.nowMs, readable.length);
      const row = db
        .prepare("SELECT set_id FROM acl_path_sets WHERE acl_fingerprint = ? AND vault_id = ?")
        .get(opts.aclFingerprint, opts.vaultId) as { set_id: number };
      db.prepare("DELETE FROM acl_path_members WHERE set_id = ?").run(row.set_id);
      const ins = db.prepare("INSERT INTO acl_path_members (set_id, path) VALUES (?, ?)");
      for (const p of readable) ins.run(row.set_id, p);
      db.exec("COMMIT");
      evictAclPathSets(db, opts.maxSets ?? DEFAULT_MAX_SETS);
      return row.set_id;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction may already be gone; the outer catch owns the outcome */
      }
      throw e;
    }
  } catch {
    return null;
  }
}

/**
 * Drop all but the `maxSets` most recently built sets. Returns how many were removed.
 *
 * Deletes MEMBERS FIRST and explicitly, rather than leaning on ON DELETE CASCADE. `foreign_keys` is
 * per-connection runtime state — every adapter sets it ON today, but a raw connection opened by a
 * script or a future harness would silently lose the cascade. That matters more here than anywhere
 * else in the codebase: eviction deletes the row holding the largest set_id, and without
 * AUTOINCREMENT SQLite REUSES that id for the next set. A stranded member would then be joined by
 * a different caller's set. The cascade stays in the schema as the backstop for any path that
 * forgets this.
 */
export function evictAclPathSets(db: Database, maxSets: number): number {
  if (!hasAclPathSets(db)) return 0;
  try {
    const doomed = db
      .prepare("SELECT set_id FROM acl_path_sets ORDER BY built_at DESC, set_id DESC LIMIT -1 OFFSET ?")
      .all(maxSets) as Array<{ set_id: number }>;
    if (doomed.length === 0) return 0;
    const delMembers = db.prepare("DELETE FROM acl_path_members WHERE set_id = ?");
    const delSet = db.prepare("DELETE FROM acl_path_sets WHERE set_id = ?");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const d of doomed) {
        delMembers.run(d.set_id);
        delSet.run(d.set_id);
      }
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* see ensureAclPathSet */
      }
      throw e;
    }
    return doomed.length;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/acl-path-set.test.ts > /tmp/acl-green2.log 2>&1; echo "exit=$?"
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and lint**

```bash
cd /home/ubuntu/obsidian-tc
bun run typecheck > /tmp/tc.log 2>&1; echo "typecheck=$?"
bun run lint > /tmp/lint.log 2>&1; echo "lint=$?"
```

Both expected exit 0. If lint fails on import order, run `npx @biomejs/biome check --write .`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/obsidian-tc
git add packages/server/src/search/acl_path_set.ts packages/server/test/acl-path-set.test.ts
git commit -s -m "feat(acl): build, read and evict the permitted-path set (THE-694, THE-695)"
```

---

### Task 3: Close THE-694 — stop probing when the caller is restricted

**Files:**
- Modify: `packages/server/src/search/router.ts:97-135` (`termDf`), `:141-155` (`routeQuery` opts), `:172-188` (the rare-term block)
- Modify: `packages/server/src/tools/m7/knowledge/graph-search.ts:75`, `knowledge-search.ts:52`, `vault-context.ts:133`, `reflect.ts:59`
- Test: `packages/server/test/router-acl-probe.test.ts` (create)

**Interfaces:**
- Consumes: `readEnumerationUnrestricted` from `../vault/acl-read-filter`.
- Produces: `routeQuery` gains `opts.readUnrestricted?: boolean`. `termDf` loses its `isReadable` parameter entirely — its new signature is `termDf(db: Database, vaultId: string, term: string, rareDfMax?: number): number`.

**Why this and not a join:** measured on a live snapshot, joining the permitted set leaves the timing oracle wide open — a term present only in denied notes took 3.381 ms against 0.047 ms for an absent term, both returning 0. That is 72x with non-overlapping distributions, because SQLite still scans the whole match list (`SCAN chunk_fts VIRTUAL TABLE` then a per-row PK probe). The only thing that closes it is not asking.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/router-acl-probe.test.ts`:

```ts
// THE-694 — the router's rare-term probe is the timing oracle. A restricted caller must not issue
// it at all: the value channel was closed by THE-691, but latency still correlated with how much
// DENIED content matched a caller-supplied term (measured 72x, non-overlapping distributions).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { routeQuery } from "../src/search/router";
import { openMemoryDb } from "./helpers";

const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${f}`, import.meta.url)), "utf8");
const CHAIN = CACHE_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));

/** A db that COUNTS how many statements were prepared, so "did it probe?" is observable. */
function countingDb() {
  const db = openMemoryDb();
  runMigrations(db, CHAIN);
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(vault_id UNINDEXED, chunk_id UNINDEXED, path, content)",
  );
  db.prepare(
    "INSERT INTO chunk_fts (vault_id, chunk_id, path, content) VALUES ('main','c1','09-secret/s.md','zarquon appears only here')",
  ).run();
  let prepares = 0;
  const raw = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (sql.includes("chunk_fts")) prepares++;
    return raw(sql);
  };
  return { db, probes: () => prepares };
}

describe("THE-694 rare-term probe gating", () => {
  it("does NOT touch chunk_fts when read enumeration is restricted", () => {
    const { db, probes } = countingDb();
    const d = routeQuery(db, "main", "zarquon", {
      isReadable: (p) => p.startsWith("02-"),
      readUnrestricted: false,
    });
    // No probe issued -> nothing to time -> the oracle is closed by construction.
    expect(probes()).toBe(0);
    expect(d.class).toBe("standard");
    expect(d.signals.join(" ")).not.toContain("rare-term");
    db.close?.();
  });

  it("still probes for an unrestricted caller, where the count leaks nothing", () => {
    const { db, probes } = countingDb();
    const d = routeQuery(db, "main", "zarquon", { readUnrestricted: true });
    expect(probes()).toBeGreaterThan(0);
    expect(d.signals.join(" ")).toContain("rare-term:zarquon");
    expect(d.class).toBe("lexical");
    db.close?.();
  });

  it("treats a caller with no ACL at all as unrestricted", () => {
    const { db, probes } = countingDb();
    routeQuery(db, "main", "zarquon", {});
    expect(probes()).toBeGreaterThan(0);
    db.close?.();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/router-acl-probe.test.ts > /tmp/router-red.log 2>&1; echo "exit=$?"
```

Expected: FAIL on the first case — `probes()` is `1`, not `0`, because the restricted caller currently runs the paged scan.

- [ ] **Step 3: Replace `termDf` and gate the probe**

In `packages/server/src/search/router.ts`, replace the whole `termDf` function (lines 97-135) with:

```ts
/**
 * Exact document frequency for a term, over the WHOLE vault.
 *
 * No ACL parameter, deliberately. THE-691 made the readable count exact by paging and filtering in
 * JS; THE-694 then measured that the residual timing channel was the real problem, and that no
 * in-SQL filter closes it — SQLite still scans the entire match list, so latency tracks TOTAL
 * matches however the predicate is expressed. The paged scan that used to live here has been
 * DELETED rather than left reachable: `routeQuery` now issues this only for callers who can read
 * everything, for whom a whole-vault count discloses nothing they could not already retrieve.
 */
function termDf(db: Database, vaultId: string, term: string, rareDfMax = 3): number {
  const quoted = `"${term.replace(/"/g, "")}"`;
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE vault_id = ? AND chunk_fts MATCH ?")
      .get(vaultId, quoted) as { n: number } | undefined;
    const n = row?.n ?? 0;
    // Past the rare window the exact value is irrelevant to every caller of this function.
    return n > rareDfMax ? rareDfMax + 1 : n;
  } catch {
    return 0;
  }
}
```

Delete the now-unused `DF_PAGE` constant (search for `DF_PAGE` and remove its declaration).

- [ ] **Step 4: Add the option and gate the block**

In `routeQuery`'s `opts` (line 145), add after `isReadable`:

```ts
    /** THE-694: true when the caller can read the whole vault (readEnumerationUnrestricted). The
     *  rare-term probe runs ONLY then. For a restricted caller the probe is skipped entirely —
     *  not filtered, not capped, not issued — because its LATENCY is the disclosure, and no
     *  in-SQL predicate removes that. Restricted callers lose a ranking optimization, not
     *  correctness: they fall through to `standard`, which is the same path they took before the
     *  router existed. */
    readUnrestricted?: boolean;
```

Then replace the rare-term block's condition (line 172) so the probe is gated:

```ts
  // THE-694: probe only when the caller sees everything. `isReadable` absent means no ACL at all.
  const mayProbe = opts.isReadable === undefined || opts.readUnrestricted === true;
  if (mayProbe && tokens.length > 0 && tokens.length <= 5) {
```

and inside it change the call to drop the ACL argument:

```ts
      const df = termDf(db, vaultId, t, rareDfMax);
```

- [ ] **Step 5: Thread the flag at all four call sites**

In each of `packages/server/src/tools/m7/knowledge/graph-search.ts:75`, `knowledge-search.ts:52`, `vault-context.ts:133`, `reflect.ts:59`, change the `routeQuery` options object from:

```ts
{ isReadable: (p) => readableRel(ctx.acl, p) }
```

to:

```ts
{
  isReadable: (p) => readableRel(ctx.acl, p),
  readUnrestricted: readEnumerationUnrestricted(ctx.acl),
}
```

and add `readEnumerationUnrestricted` to the existing `readableRel` import from `../../../vault/acl-read-filter` in each file.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/router-acl-probe.test.ts test/router.test.ts test/lexical-sparse-acl.test.ts > /tmp/router-green.log 2>&1; echo "exit=$?"
```

Expected: PASS. If `test/router.test.ts` has a case asserting the paged behaviour, update it to the new contract rather than restoring the paging.

- [ ] **Step 7: Typecheck, then commit**

```bash
cd /home/ubuntu/obsidian-tc
bun run typecheck > /tmp/tc3.log 2>&1; echo "typecheck=$?"
git add packages/server/src/search/router.ts packages/server/src/tools/m7/knowledge/ packages/server/test/router-acl-probe.test.ts
git commit -s -m "fix(router): stop probing term df for restricted callers (THE-694)"
```

---

### Task 4: Close THE-695 item 2 — exact BM25 filtering

**Files:**
- Modify: `packages/server/src/search/chunk_fts.ts:208-238` (`bm25Chunks`)
- Modify: `packages/server/src/search/graph_search_stages/seed_generation.ts:49`
- Test: `packages/server/test/bm25-acl-exact.test.ts` (create)

**Interfaces:**
- Consumes: `ensureAclPathSet` (Task 2).
- Produces: `bm25Chunks(db, vaultId, query, k, isReadable?, aclSetId?)` — when `aclSetId` is a number, filtering happens in SQL with no over-fetch; otherwise behaviour is byte-identical to today.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/bm25-acl-exact.test.ts`:

```ts
// THE-695 item 2 — the over-fetch boundary leaks the returned LENGTH. bm25Chunks over-fetches
// F = k*20 + 50, filters in JS, then cuts to k. When it underfills, that is because EXCLUDED rows
// outranked the caller's, so the length depends on hidden content. Reproduced at k=1: 69
// higher-scoring hidden matches return the readable row, 70 return nothing.
import { describe, expect, it } from "vitest";
import { bm25Chunks } from "../src/search/chunk_fts";
import { openMemoryDb } from "./helpers";
import type { Database } from "../src/db/types";

function seeded(hiddenCount: number): Database {
  const db = openMemoryDb();
  db.exec(
    "CREATE VIRTUAL TABLE chunk_fts USING fts5(vault_id UNINDEXED, chunk_id UNINDEXED, path, content)",
  );
  db.exec(
    "CREATE TABLE chunks (id TEXT PRIMARY KEY, vault_id TEXT, path TEXT, content TEXT)",
  );
  db.exec("CREATE TABLE acl_path_sets (set_id INTEGER PRIMARY KEY, acl_fingerprint TEXT, vault_id TEXT, generation INTEGER, built_at INTEGER, path_count INTEGER, UNIQUE(acl_fingerprint, vault_id))");
  db.exec("CREATE TABLE acl_path_members (set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY (set_id, path)) WITHOUT ROWID");
  db.prepare("INSERT INTO acl_path_sets VALUES (1,'fp','main',1,1,1)").run();
  db.prepare("INSERT INTO acl_path_members VALUES (1,'02-visible.md')").run();
  const addFts = db.prepare("INSERT INTO chunk_fts (vault_id, chunk_id, path, content) VALUES ('main',?,?,?)");
  const addChunk = db.prepare("INSERT INTO chunks (id, vault_id, path, content) VALUES (?, 'main', ?, ?)");
  // Hidden rows first so they win on rank (shorter docs rank higher under bm25).
  for (let i = 0; i < hiddenCount; i++) {
    addFts.run(`h${i}`, "09-hidden.md", "needle");
    addChunk.run(`h${i}`, "09-hidden.md", "needle");
  }
  addFts.run("v1", "02-visible.md", "needle needle needle needle");
  addChunk.run("v1", "02-visible.md", "needle needle needle needle");
  return db;
}

const readable = (p: string) => p === "02-visible.md";

describe("THE-695 bm25 over-fetch boundary", () => {
  it("underfills today once hidden rows exceed the over-fetch window", () => {
    // k=1 -> F = 70. With 70 higher-ranked hidden rows the readable row falls outside the window.
    const db = seeded(70);
    expect(bm25Chunks(db, "main", "needle", 1, readable)).toStrictEqual([]);
    db.close?.();
  });

  it("finds the readable row regardless of hidden volume when the set is joined", () => {
    const db = seeded(70);
    const hits = bm25Chunks(db, "main", "needle", 1, readable, 1);
    expect(hits.map((h) => h.path)).toStrictEqual(["02-visible.md"]);
    db.close?.();
  });

  it("returns the same result at a hidden volume the old path also handled", () => {
    const db = seeded(5);
    const withSet = bm25Chunks(db, "main", "needle", 1, readable, 1);
    const withoutSet = bm25Chunks(db, "main", "needle", 1, readable);
    expect(withSet.map((h) => h.path)).toStrictEqual(withoutSet.map((h) => h.path));
    db.close?.();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/bm25-acl-exact.test.ts > /tmp/bm25-red.log 2>&1; echo "exit=$?"
```

Expected: the first test PASSES (it documents today's defect) and the second FAILS — `bm25Chunks` takes five parameters, so the sixth is ignored and the result is `[]`.

- [ ] **Step 3: Add the exact path**

In `packages/server/src/search/chunk_fts.ts`, change the signature and add the joined branch:

```ts
export function bm25Chunks(
  db: Database,
  vaultId: string,
  query: string,
  k: number,
  isReadable?: (path: string) => boolean,
  /** THE-695: an acl_path_members set_id. When present, filtering happens IN SQL and the
   *  over-fetch is not needed — the returned length no longer depends on how many higher-scoring
   *  hidden rows exist, which is the channel this closes. */
  aclSetId?: number,
): LexicalHit[] {
  if (k <= 0) return [];
  const match = chunkFtsMatch(query);
  if (match === null) return [];
  const readable = isReadable ?? (() => true);
  try {
    if (aclSetId !== undefined) {
      return db
        .prepare(
          "SELECT chunk_fts.chunk_id AS chunk_id, chunk_fts.path AS path, chunks.content AS content, bm25(chunk_fts) AS rank FROM chunk_fts JOIN chunks ON chunks.id = chunk_fts.chunk_id JOIN acl_path_members a ON a.set_id = ? AND a.path = chunk_fts.path WHERE chunk_fts.vault_id = ? AND chunk_fts MATCH ? ORDER BY rank LIMIT ?",
        )
        .all(aclSetId, vaultId, match, k) as LexicalHit[];
    }
    // Same constant as semantic.ts's KNN over-fetch, deliberately — one number to reason about when
    // asking "how hidden can a vault be before an arm underfills?".
    const overFetch = isReadable ? k * 20 + 50 : k;
    return db
      .prepare(
        "SELECT chunk_fts.chunk_id AS chunk_id, chunk_fts.path AS path, chunks.content AS content, bm25(chunk_fts) AS rank FROM chunk_fts JOIN chunks ON chunks.id = chunk_fts.chunk_id WHERE chunk_fts.vault_id = ? AND chunk_fts MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(vaultId, match, overFetch)
      .filter((r) => readable((r as LexicalHit).path))
      .slice(0, k) as LexicalHit[];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/bm25-acl-exact.test.ts test/lexical-sparse-acl.test.ts > /tmp/bm25-green.log 2>&1; echo "exit=$?"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/obsidian-tc
git add packages/server/src/search/chunk_fts.ts packages/server/test/bm25-acl-exact.test.ts
git commit -s -m "fix(search): exact ACL filtering for bm25, dropping the over-fetch boundary (THE-695)"
```

---

### Task 5: Close THE-695 item 1 — filter the graph walk, behind a flag

**Files:**
- Modify: `packages/server/src/search/graph_expand.ts:55-105`
- Modify: `packages/server/src/search/graph_search_stages/types.ts:118-132` (add the option)
- Modify: `packages/server/src/search/graph_search_stages/graph_expansion.ts:62`
- Test: `packages/server/test/graph-walk-acl.test.ts` (create)

**Interfaces:**
- Consumes: Task 2's tables.
- Produces: `expandGraphLiteral(db, seedPaths, { vaultId, hopLimit?, includeDerived?, aclSetId? })`. When `aclSetId` is a number, an unreadable note cannot be traversed. `GraphSearchOptions` gains `aclWalkFilter?: { enabled?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/graph-walk-acl.test.ts`:

```ts
// THE-695 item 1 — an unreadable note is a usable BRIDGE. readable A -> unreadable S -> readable B
// reaches B at hop 2 ONLY because S exists, so the presence of an unreadable note changes the
// READABLE result set. expandGraphLiteral has no ACL awareness; graph_expansion.ts filters only the
// hydrated rows, after the walk has finished.
import { describe, expect, it } from "vitest";
import { expandGraphLiteral } from "../src/search/graph_expand";
import { openMemoryDb } from "./helpers";
import type { Database } from "../src/db/types";

function bridged(): Database {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE vault_edges (vault_id TEXT, source_path TEXT, target_path TEXT, edge_type TEXT, edge_kind TEXT, provenance TEXT)",
  );
  db.exec("CREATE TABLE acl_path_sets (set_id INTEGER PRIMARY KEY, acl_fingerprint TEXT, vault_id TEXT, generation INTEGER, built_at INTEGER, path_count INTEGER, UNIQUE(acl_fingerprint, vault_id))");
  db.exec("CREATE TABLE acl_path_members (set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY (set_id, path)) WITHOUT ROWID");
  const e = db.prepare(
    "INSERT INTO vault_edges VALUES ('main', ?, ?, 'links_to', 'literal', 'body')",
  );
  e.run("public/a.md", "secret/s.md");
  e.run("secret/s.md", "public/b.md");
  db.prepare("INSERT INTO acl_path_sets VALUES (1,'fp','main',1,1,2)").run();
  const m = db.prepare("INSERT INTO acl_path_members VALUES (1, ?)");
  m.run("public/a.md");
  m.run("public/b.md"); // s.md deliberately absent
  return db;
}

describe("THE-695 graph walk bridges", () => {
  it("reaches B through an unreadable bridge today", () => {
    const db = bridged();
    const paths = expandGraphLiteral(db, ["public/a.md"], { vaultId: "main", hopLimit: 2 }).map(
      (n) => n.path,
    );
    expect(paths).toContain("public/b.md"); // documents the defect
    db.close?.();
  });

  it("cannot traverse the unreadable bridge when the set is joined", () => {
    const db = bridged();
    const paths = expandGraphLiteral(db, ["public/a.md"], {
      vaultId: "main",
      hopLimit: 2,
      aclSetId: 1,
    }).map((n) => n.path);
    // B is READABLE, but it was only reachable via S. Its presence therefore depended on an
    // unreadable note, which is the non-interference violation.
    expect(paths).not.toContain("public/b.md");
    expect(paths).not.toContain("secret/s.md");
    db.close?.();
  });

  it("still reaches a readable neighbour that needs no bridge", () => {
    const db = bridged();
    db.prepare(
      "INSERT INTO vault_edges VALUES ('main','public/a.md','public/c.md','links_to','literal','body')",
    ).run();
    db.prepare("INSERT INTO acl_path_members VALUES (1,'public/c.md')").run();
    const paths = expandGraphLiteral(db, ["public/a.md"], {
      vaultId: "main",
      hopLimit: 2,
      aclSetId: 1,
    }).map((n) => n.path);
    expect(paths).toContain("public/c.md"); // pruning bridges must not prune direct links
    db.close?.();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/graph-walk-acl.test.ts > /tmp/walk-red.log 2>&1; echo "exit=$?"
```

Expected: test 1 passes (documents the defect), tests 2 and 3 FAIL — `aclSetId` is ignored, so `public/b.md` is still returned.

- [ ] **Step 3: Add the optional join to the CTE**

In `packages/server/src/search/graph_expand.ts`, change the signature and build the recursive step conditionally:

```ts
export function expandGraphLiteral(
  db: Database,
  seedPaths: string[],
  opts: {
    vaultId: string;
    hopLimit?: number;
    includeDerived?: boolean;
    /** THE-695: an acl_path_members set_id. When present, a node the caller cannot read cannot be
     *  TRAVERSED — not merely omitted from the results. Filtering only the hydrated rows (which is
     *  what graph_expansion.ts does) leaves an unreadable note usable as a bridge, so the readable
     *  result set depends on unreadable material. */
    aclSetId?: number;
  },
): ExpansionNode[] {
```

Then, inside the prepared SQL, replace the recursive `walk` member's `JOIN undirected u ...` line with a version that also joins the member table when a set is supplied. Build the fragment before the template literal:

```ts
  const aclJoin =
    opts.aclSetId === undefined
      ? ""
      : "JOIN acl_path_members am ON am.set_id = ? AND am.path = u.target_path";
```

and use it in the recursive step:

```
         FROM walk w
         JOIN undirected u ON u.source_path = w.current_path
         ${aclJoin}
         WHERE w.hop < ? AND instr(w.visited, char(10) || u.target_path || char(10)) = 0
```

Finally add the parameter in the correct position — it binds after `JSON.stringify(seedPaths)` and before `hopLimit`, matching the order the placeholders appear:

```ts
    .all(
      opts.vaultId,
      ...edgeTypes,
      opts.vaultId,
      ...edgeTypes,
      JSON.stringify(seedPaths),
      ...(opts.aclSetId === undefined ? [] : [opts.aclSetId]),
      hopLimit,
    ) as WalkRow[];
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/graph-walk-acl.test.ts > /tmp/walk-green.log 2>&1; echo "exit=$?"
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Add the config flag and thread it**

In `packages/server/src/search/graph_search_stages/types.ts`, after the `smoothExpansion` field (line 132), add:

```ts
  /** THE-695: filter the graph WALK by the caller's permitted-path set, so an unreadable note
   *  cannot serve as a bridge between two readable ones. OFF by default and shipped dark: pruning
   *  bridges is a RECALL change (measured 583 -> 57 nodes on a deliberately harsh test ACL), so it
   *  is decided by the eval, not by assertion. Evaluated jointly with THE-693's hubDegreeCap
   *  because both land in graph_expansion.ts and nodeDegrees is itself computed with no ACL. */
  aclWalkFilter?: { enabled?: boolean };
```

In `packages/server/src/search/graph_search_stages/graph_expansion.ts`, at the `expandGraphLiteral` call (line 62), pass the set id only when the flag is on. Add above the call:

```ts
  // THE-695: dark by default. `opts.aclSetId` is resolved by the caller (tool wiring) via
  // ensureAclPathSet; absent means the substrate was unavailable and the existing hydrated-row
  // filter below remains the only ACL applied, which is exactly today's behaviour.
  const aclSetId = opts.aclWalkFilter?.enabled === true ? opts.aclSetId : undefined;
```

and add `...(aclSetId !== undefined ? { aclSetId } : {})` to the options object passed to `expandGraphLiteral`.

Add `aclSetId?: number` alongside `aclWalkFilter` in `types.ts` so the resolved id can be threaded.

- [ ] **Step 6: Typecheck, run the graph suites, commit**

```bash
cd /home/ubuntu/obsidian-tc && bun run typecheck > /tmp/tc5.log 2>&1; echo "typecheck=$?"
cd packages/server && ../../scripts/with-host-budget.sh node ./node_modules/vitest/vitest.mjs run test/graph-walk-acl.test.ts test/graph-diversify.test.ts test/query-cache-key-coverage.test.ts > /tmp/graph-green.log 2>&1; echo "exit=$?"
```

`query-cache-key-coverage.test.ts` will fail if a new option is not accounted for in the cache key — add `aclWalkFilter` and `aclSetId` to its reviewed list, since both change results and must therefore be part of the key.

```bash
cd /home/ubuntu/obsidian-tc
git add packages/server/src/search/graph_expand.ts packages/server/src/search/graph_search_stages/ packages/server/test/graph-walk-acl.test.ts
git commit -s -m "feat(search): ACL-filter the graph walk behind a flag (THE-695)"
```

---

### Task 6: Wire the eval arms and run the three-arm measurement

**Files:**
- Modify: `packages/server/eval/run.ts` (flag threading)
- Create: `~/obsidian-tc-eval/analyze-the693-arms.ts` (analysis, modelled on `analyze-the692-sweep-corrected.ts`)

**Interfaces:**
- Consumes: Task 5's `aclWalkFilter`, and THE-693's existing `graphStream.enabled` / `smoothExpansion.enabled`.
- Produces: an nDCG@10 comparison across three arms with permutation testing and BH-FDR correction.

**Critical:** a new eval flag needs threading in FOUR places and every miss is silent. Before trusting any null result, count how many queries actually differ between arms — a null from arms that produced identical results is a threading bug, not a finding.

- [ ] **Step 1: Thread the flags through the eval harness**

Add `--acl-walk-filter`, and confirm `--graph-stream` / `--smooth-expansion` already exist, in `packages/server/eval/run.ts`. Follow the exact pattern `--max-per-cluster` used (added in PR #646): the flag must reach the **searchOptions object**, not merely be parsed. That was the THE-692 trap — the parameter was inert because it never reached `searchOptions`.

- [ ] **Step 2: Verify the flag is not inert BEFORE running the full grid**

```bash
cd ~/obsidian-tc-eval
# Two arms, 20 queries, then count differing results. If 0 differ, the flag is inert.
bun run eval --limit 20 --arm-a "" --arm-b "--acl-walk-filter" --out /tmp/arm-probe.json
```

Expected: a non-zero count of differing queries. If zero, stop and fix the threading — do not proceed to the full run.

- [ ] **Step 3: Run the three arms at n=250**

```bash
cd ~/obsidian-tc-eval
bun run eval --corpus /data/obsidian-tc-eval/cache-the674-bgem3 --limit 250 --out arm-off.json
bun run eval --corpus /data/obsidian-tc-eval/cache-the674-bgem3 --limit 250 --graph-stream --out arm-hardcap.json
bun run eval --corpus /data/obsidian-tc-eval/cache-the674-bgem3 --limit 250 --smooth-expansion --out arm-smooth.json
```

- [ ] **Step 4: Analyse with the shared statistics module**

Use `eval/stats.ts` (permutation test + BH-FDR at q=0.10 + non-inferiority) via the template at `~/obsidian-tc-eval/analyze-the692-sweep-corrected.ts`. Do not hand-roll the analysis — a previous hand-rolled version was superseded.

Standing bar: sigma_d 0.204 / MDE 0.036 at n=250 (THE-674). An effect below ~0.036 is **below resolution**, not absent, and must be reported that way. The bar is metric-specific — `bridge_ndcg_at_10` is n=103 with MDE 0.0617.

- [ ] **Step 5: Post the result and decide**

Post the table to THE-693 and THE-695 with the differing-query count, the effect sizes, and the q-values. Enable the winning arm in config **only** if it clears the bar; otherwise record the null and leave both flags off, as THE-692 did.

- [ ] **Step 6: Commit the eval wiring**

```bash
cd /home/ubuntu/obsidian-tc
git add packages/server/eval/run.ts
git commit -s -m "feat(eval): --acl-walk-filter arm for the THE-693/695 measurement"
```

---

## Self-Review

**Spec coverage:** schema (Task 1), module with empty-set floor + LRU + rowid-reuse regression (Task 2), THE-694 probe skip (Task 3), BM25 exactness (Task 4), walk filter behind a flag (Task 5), three-arm eval (Task 6). The spec's read-only-degradation requirement is covered by Task 2's "returns null rather than throwing" test; the PRAGMA-independence requirement by Task 2's `foreign_keys = OFF` test.

**Type consistency:** `ensureAclPathSet` returns `number | null` in Task 2 and is consumed as a `number` in Tasks 4-5 via `aclSetId?: number`. `bm25Chunks`'s sixth parameter is named `aclSetId` in both its definition (Task 4) and the spec. `expandGraphLiteral`'s option is `aclSetId` in Task 5, matching.

**Known gap, deliberately left:** Tasks 4 and 5 add the `aclSetId` *parameter* but do not wire the *resolution* of that id at the tool call sites — that requires `aclFingerprint` and `readGeneration` to be threaded into `graph_search_stages`, which is a wiring change that belongs with the eval arm in Task 6 rather than blocking the pure-SQL changes. Until then both new paths are reachable only from tests and the eval harness, which is the intended dark-ship posture.
