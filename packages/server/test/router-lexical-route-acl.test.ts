// THE-853 (security, cross-vendor review follow-up) — `lexicalRouteResults` (router.ts) is one of
// two additional direct `bm25Chunks` callers the original THE-853 pass missed: it called
// `bm25Chunks` with `isReadable` only, never an `aclSetId`, so a restricted caller ALWAYS took the
// over-fetch-then-JS-filter fallback and its THE-695 residual length-interference channel, even
// when an `acl_path_members` set had already been resolved for them elsewhere in the request.
//
// Same fixture shape as bm25-acl-exact.test.ts / seed-generation-acl.test.ts: hidden (unreadable)
// rows carry the term ONCE, the readable row carries it many times (bm25 ranks short docs above
// long ones), so enough hidden volume pushes the readable row outside the over-fetch window.
//
// Also proves the NEW fail-closed contract this ticket adds: `blocked: true` (the same signal
// `resolveAclWalkFilter`/graph_expansion.ts already use for the graph walk) must skip the lexical
// short-circuit entirely — never fall through to the leaky fallback — mirroring
// graph_expansion.ts's handling of the identical flag.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { lexicalRouteResults } from "../src/search/router";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "main";
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
  db.prepare("INSERT INTO acl_path_sets VALUES (?,'fp','main',1,1,1)").run(READABLE_SET);
  db.prepare("INSERT INTO acl_path_members VALUES (?,'02-visible.md')").run(READABLE_SET);

  const addChunk = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, '0', '[]', ?, ?, 1, 0, 0)",
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

describe("THE-853 lexicalRouteResults threads aclSetId into bm25Chunks", () => {
  it("underfills today once hidden rows fill the over-fetch window, even with an aclSetId resolved", () => {
    // Documents the defect: the router doesn't NEED to know an aclSetId to leak — it just never
    // asked for one. This case is expected to hold before and after the fix (k=1 -> the effective
    // bm25Chunks over-fetch window is Math.max(k*2,k)*20+50 = 90; 90 higher-ranked hidden rows
    // push the readable row outside it) — it's what makes the next test non-vacuous.
    const db = seeded(90);
    expect(lexicalRouteResults(db, VAULT, "needle", 1, readable)).toEqual([]);
  });

  it("finds the readable row regardless of hidden volume once aclSetId is threaded", () => {
    const db = seeded(90);
    const results = lexicalRouteResults(db, VAULT, "needle", 1, readable, READABLE_SET);
    expect(results.map((r) => r.path)).toStrictEqual(["02-visible.md"]);
    expect(results[0]?.source).toBe("lexical");
  });

  it("non-interference: unaffected by hidden volume once threaded — 90 hidden and 500 hidden agree", () => {
    const few = lexicalRouteResults(seeded(90), VAULT, "needle", 1, readable, READABLE_SET).map(
      (r) => r.path,
    );
    const many = lexicalRouteResults(seeded(500), VAULT, "needle", 1, readable, READABLE_SET).map(
      (r) => r.path,
    );
    expect(many).toStrictEqual(few);
    expect(many).toStrictEqual(["02-visible.md"]);
  });

  it("blocked:true fails closed — returns no results rather than the leaky fallback, and warns", () => {
    // Non-vacuous: at this hidden volume the UNBLOCKED, no-aclSetId call (the pre-fix shape)
    // still succeeds via the fallback, so `blocked` is doing real work here, not defaulting to an
    // already-empty result.
    const db = seeded(3);
    expect(lexicalRouteResults(db, VAULT, "needle", 1, readable)).not.toEqual([]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocked = lexicalRouteResults(db, VAULT, "needle", 1, readable, undefined, true);
    expect(blocked).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("THE-853");
    warn.mockRestore();
  });

  it("never returns an unreadable chunk regardless of aclSetId (isReadable still applies)", () => {
    const db = seeded(3);
    const withoutSet = lexicalRouteResults(db, VAULT, "needle", 5, readable);
    const withSet = lexicalRouteResults(db, VAULT, "needle", 5, readable, READABLE_SET);
    for (const r of [...withoutSet, ...withSet]) {
      expect(r.path).toBe("02-visible.md");
    }
  });
});
