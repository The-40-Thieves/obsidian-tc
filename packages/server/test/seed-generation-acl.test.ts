// THE-853 (security) — the lexical seed arm's dark aclSetId path.
//
// `bm25Chunks` already carries the correct fix (THE-695): when given an `acl_path_members`
// set_id, it filters via SQL JOIN + LIMIT so the returned LENGTH stops depending on how many
// higher-scoring UNREADABLE rows exist ahead of it in the MATCH order (see chunk_fts.ts's header
// comment for the exact boundary — underfill begins once the hidden fraction of the top-F MATCH
// prefix exceeds 1 - k/F). But `graph_search_stages/seed_generation.ts`'s `generateSeeds` — the
// caller graphSearch actually uses — passed only `isReadable`, never `opts.aclSetId`, so a
// restricted caller always took the over-fetch-then-JS-filter fallback and its residual
// length-interference channel, regardless of whether an aclSetId had already been resolved for
// them elsewhere in the pipeline (THE-852's resolveAclWalkFilter).
//
// Same fixture shape as bm25-acl-exact.test.ts, exercised through generateSeeds instead of
// bm25Chunks directly, so this proves the CALL SITE threads the id — not just that bm25Chunks
// itself is capable of using one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { generateSeeds } from "../src/search/graph_search_stages/seed_generation";
import type { GraphSearchOptions } from "../src/search/graph_search_stages/types";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";
const READABLE_SET = 1;

/** Hidden rows carry the term ONCE and the readable row carries it many times, so bm25 ranks the
 *  short hidden docs above the long readable one — the ordering that produces underfill (same
 *  shape as bm25-acl-exact.test.ts's `seeded`). */
function seeded(hiddenCount: number): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    "CREATE TABLE acl_path_sets (set_id INTEGER PRIMARY KEY, acl_fingerprint TEXT NOT NULL, vault_id TEXT NOT NULL, generation INTEGER NOT NULL, built_at INTEGER NOT NULL, path_count INTEGER NOT NULL, UNIQUE (acl_fingerprint, vault_id))",
  );
  db.exec(
    "CREATE TABLE acl_path_members (set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY (set_id, path)) WITHOUT ROWID",
  );
  db.prepare("INSERT INTO acl_path_sets VALUES (?,'fp','v1',1,1,1)").run(READABLE_SET);
  db.prepare("INSERT INTO acl_path_members VALUES (?,'02-visible.md')").run(READABLE_SET);

  const addChunk = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, 0)",
  );
  for (let i = 0; i < hiddenCount; i++) {
    addChunk.run(`h${i}`, "09-hidden.md", "needle", `hh${i}`);
  }
  const long = `needle ${"filler ".repeat(40)}`;
  addChunk.run("v1c", "02-visible.md", long, "hv1");

  if (!ensureChunkFts(db)) {
    throw new Error(
      "FTS5 unavailable — THE-853's assertions cannot run. Refusing to pass vacuously.",
    );
  }
  return db;
}

const readable = (p: string): boolean => p === "02-visible.md";

const opts = (extra: Partial<GraphSearchOptions>): GraphSearchOptions => ({
  query: "needle",
  queryVec: [1, 0, 0, 0],
  vaultId: VAULT,
  finalTopK: 1,
  isReadable: readable,
  lexical: { count: 1 },
  ...extra,
});

describe("THE-853 generateSeeds threads opts.aclSetId into the lexical arm", () => {
  it("underfills today once hidden rows fill the over-fetch window, even with an aclSetId resolved", () => {
    // Documents the defect: an aclSetId is available (READABLE_SET) but the pre-fix call site
    // never passed it, so the readable seed is lost behind 70 higher-ranked hidden rows.
    const db = seeded(70);
    const { lexHits } = generateSeeds({ db, opts: opts({}), seedCount: 1 });
    // This assertion is expected to hold both before and after the fix — it's what proves the
    // next test (WITH aclSetId) is non-vacuous, not a regression check on its own.
    expect(lexHits).toStrictEqual([]);
  });

  it("finds the readable seed regardless of hidden volume once aclSetId is threaded", () => {
    const db = seeded(70);
    const { lexHits } = generateSeeds({
      db,
      opts: opts({ aclSetId: READABLE_SET }),
      seedCount: 1,
    });
    expect(lexHits.map((h) => h.path)).toStrictEqual(["02-visible.md"]);
  });

  it("non-interference: the readable seed is unaffected by hidden volume once threaded", () => {
    const few = generateSeeds({
      db: seeded(70),
      opts: opts({ aclSetId: READABLE_SET }),
      seedCount: 1,
    }).lexHits.map((h) => h.path);
    const many = generateSeeds({
      db: seeded(500),
      opts: opts({ aclSetId: READABLE_SET }),
      seedCount: 1,
    }).lexHits.map((h) => h.path);
    expect(many).toStrictEqual(few);
    expect(many).toStrictEqual(["02-visible.md"]);
  });

  it("fails CLOSED for a blocked caller (restricted, ACL set unresolved) instead of the leaky fallback", () => {
    // resolveAclWalkFilter returns { enabled: true, blocked: true } with NO aclSetId for a
    // restricted caller whose set could not be resolved. The pre-fix arm called bm25Chunks with an
    // undefined aclSetId and took the over-fetch fallback — the exact channel this ticket closes.
    // seeded(0): the readable row alone matches, so the fallback would return it; the guard must
    // return nothing rather than serve a caller whose true visibility is unknown.
    const db = seeded(0);
    const { lexHits } = generateSeeds({
      db,
      opts: opts({ aclWalkFilter: { enabled: true, blocked: true } }),
      seedCount: 1,
    });
    expect(lexHits).toStrictEqual([]);
  });

  it("never returns an unreadable chunk regardless of aclSetId (isReadable still applies)", () => {
    const db = seeded(3);
    const withoutSet = generateSeeds({ db, opts: opts({}), seedCount: 1 }).lexHits;
    const withSet = generateSeeds({
      db,
      opts: opts({ aclSetId: READABLE_SET }),
      seedCount: 1,
    }).lexHits;
    for (const hit of [...withoutSet, ...withSet]) {
      expect(hit.path).toBe("02-visible.md");
    }
  });
});
