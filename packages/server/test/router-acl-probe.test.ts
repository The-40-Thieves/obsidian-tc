// THE-694 — the router's rare-term probe IS the timing oracle. A restricted caller must not issue
// it at all.
//
// THE-691 closed the value channel: `termDf` paged until it had an exact readable count, so the
// emitted signal and the routing class depended only on permitted matches. The latency did not.
// Measured on a live snapshot with a restricted ACL, both queries returning 0:
//
//   term present ONLY in denied notes (1,504 hidden matches) -> mean 3.381 ms
//   term absent entirely                                     -> mean 0.047 ms
//
// 72x on means, 77x on medians, non-overlapping distributions. A materialized permitted set does
// not fix it — the plan is `SCAN chunk_fts VIRTUAL TABLE` then a per-row membership probe, so work
// tracks TOTAL matches however the predicate is expressed. Moving the scan from JS into SQLite
// makes it faster and lower-variance, i.e. easier to exploit. The only thing that closes it is not
// asking the question.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { routeQuery } from "../src/search/router";
import { openMemoryDb } from "./helpers";

const read = (f: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${f}`, import.meta.url)), "utf8");
const CHAIN = CACHE_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));

/** A db that COUNTS chunk_fts statements, so "did it probe?" is directly observable rather than
 *  inferred from a timing measurement (which is the thing under test and would be circular). */
function countingDb(): { db: any; probes: () => number } {
  const db = openMemoryDb();
  runMigrations(db, CHAIN);
  // THE-711 follow-up: chunk_fts is contentless and carries no vault of its own — `termDf` resolves
  // the vault by joining `chunks` on rowid. So the fixture must seed BOTH sides; the FTS row alone
  // used to be enough, and a lone FTS row now joins to nothing and counts zero.
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('c1','main','09-secret/s.md','0','[]','zarquon appears only here','h1',1,0,0)",
  ).run();
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(content, content='', contentless_delete=1, tokenize='porter unicode61')",
  );
  db.exec("INSERT INTO chunk_fts (rowid, content) SELECT rowid, content FROM chunks");
  let prepares = 0;
  const raw = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (sql.includes("chunk_fts")) prepares++;
    return raw(sql);
  };
  return { db, probes: () => prepares };
}

describe("THE-694 rare-term probe gating", () => {
  it("does NOT touch chunk_fts when read enumeration is restricted", () => {
    const { db, probes } = countingDb();
    const d = routeQuery(db, "main", "zarquon", {
      isReadable: (p: string) => p.startsWith("02-"),
      readUnrestricted: false,
    });
    // No probe issued -> nothing to time -> the oracle is closed by construction, not narrowed.
    expect(probes()).toBe(0);
    expect(d.class).toBe("standard");
    expect(d.signals.join(" ")).not.toContain("rare-term");
    db.close?.();
  });

  it("still probes for an unrestricted caller, where a whole-vault count leaks nothing", () => {
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

  it("restricted callers fall through to standard, which is what they got before the router", () => {
    const { db } = countingDb();
    const d = routeQuery(db, "main", "some ordinary phrase about zarquon", {
      isReadable: () => true,
      readUnrestricted: false,
    });
    // Losing rare-term routing is a RANKING optimization, not correctness — restricted callers
    // still get the full standard retrieval path.
    expect(d.class).toBe("standard");
    db.close?.();
  });
});
