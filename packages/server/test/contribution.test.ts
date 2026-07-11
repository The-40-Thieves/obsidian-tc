// THE-249 — contribution-rate. Pins the aggregation (citation credits per path across chunks),
// caller attribution via workspace_sessions, window filtering, and the dead-retrieved split.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { contributionReport } from "../src/experiential/contribution";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: read("20260711_002_agent_episodes.sql") },
];
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

function cacheDb0(): Database {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE chunks (id TEXT PRIMARY KEY, path TEXT NOT NULL);" +
      "CREATE TABLE workspace_sessions (id TEXT PRIMARY KEY, caller TEXT);",
  );
  return db;
}

function seedRetrieval(
  edb: Database,
  id: string,
  chunkId: string,
  cited: number | null,
  at = NOW,
  session: string | null = null,
) {
  edb
    .prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, cited_in_response, surface_type, query_text, rank_in_results) VALUES (?, ?, ?, ?, ?, 's', 'q', 1)",
    )
    .run(id, chunkId, at, session, cited);
}

describe("contribution report (THE-249)", () => {
  it("aggregates citation credits per path across chunks, with caller attribution", () => {
    const edb = edb0();
    const cache = cacheDb0();
    // note A has two chunks; note B one chunk
    cache.prepare("INSERT INTO chunks (id, path) VALUES ('a1', 'notes/a.md')").run();
    cache.prepare("INSERT INTO chunks (id, path) VALUES ('a2', 'notes/a.md')").run();
    cache.prepare("INSERT INTO chunks (id, path) VALUES ('b1', 'notes/b.md')").run();
    cache.prepare("INSERT INTO workspace_sessions (id, caller) VALUES ('s1', 'claude')").run();

    seedRetrieval(edb, "r1", "a1", 1, NOW, "s1"); // contribution via s1
    seedRetrieval(edb, "r2", "a1", 0, NOW + 1);
    seedRetrieval(edb, "r3", "a2", 1, NOW + 2, "s1"); // second credit, same note
    seedRetrieval(edb, "r4", "b1", 0, NOW + 3); // retrieved, never cited
    seedRetrieval(edb, "r5", "b1", null, NOW + 4); // unstamped -> not a credit

    const report = contributionReport(edb, cache);
    expect(report.totals).toEqual({
      retrievedPaths: 2,
      contributingPaths: 1,
      deadRetrievedPaths: 1,
    });
    const a = report.notes.find((n) => n.path === "notes/a.md");
    expect(a).toMatchObject({
      retrievals: 3,
      contributions: 2,
      lastContributionTs: NOW + 2,
      callers: ["claude"],
    });
    const b = report.notes.find((n) => n.path === "notes/b.md");
    expect(b).toMatchObject({ retrievals: 2, contributions: 0, lastContributionTs: null });
    // sorted: contributors first
    expect(report.notes[0]?.path).toBe("notes/a.md");
  });

  it("window filtering scopes the report", () => {
    const edb = edb0();
    const cache = cacheDb0();
    cache.prepare("INSERT INTO chunks (id, path) VALUES ('a1', 'notes/a.md')").run();
    seedRetrieval(edb, "r1", "a1", 1, NOW - 10_000);
    seedRetrieval(edb, "r2", "a1", 1, NOW);
    const report = contributionReport(edb, cache, { since: NOW - 1000 });
    expect(report.notes[0]).toMatchObject({ retrievals: 1, contributions: 1 });
  });

  it("empty log -> empty report; deleted chunks are skipped", () => {
    const edb = edb0();
    const cache = cacheDb0();
    expect(contributionReport(edb, cache).totals.retrievedPaths).toBe(0);
    seedRetrieval(edb, "r1", "ghost-chunk", 1);
    expect(contributionReport(edb, cache).totals.retrievedPaths).toBe(0);
  });
});
