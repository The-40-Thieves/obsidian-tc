// THE-170 — citation inference. Pins ROUGE-L, the two-stage gate (stage-1 filter, stage-2
// judge with the 5% parse kill switch), scope isolation (only the targeted session's rows
// stamp), and the stage-1-only mode when no judge is configured.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { inferCitations, rougeL } from "../src/experiential/citation";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: read("20260711_002_agent_episodes.sql") },
  // This fixture is a deliberate MINIMAL chain, not the production one, so a new experiential
  // migration does not automatically appear here. 20260731_001 adds citation_state, which
  // inferCitations now writes — without it every stamp fails "no such column".
  { version: "20260731_001", sql: read("20260731_001_citation_state.sql") },
];
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

// Minimal authored-cache shape: only the columns citation-infer reads.
function cacheDb0(): Database {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE chunks (id TEXT PRIMARY KEY, content TEXT NOT NULL);" +
      "CREATE TABLE chunk_embeddings (chunk_id TEXT NOT NULL, embedding BLOB NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);",
  );
  return db;
}

function seedRetrieval(edb: Database, id: string, chunkId: string, session: string, at = NOW) {
  edb
    .prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, surface_type, query_text, rank_in_results) VALUES (?, ?, ?, ?, 'search_semantic', 'q', 1)",
    )
    .run(id, chunkId, at, session);
}

const TRANSCRIPT = [
  "Here is what I found about the finances.",
  "The quarterly revenue grew twelve percent in march according to the ledger notes.",
  "Let me know if you want the full breakdown.",
].join("\n\n");

const CHUNK_CITED = "quarterly revenue grew twelve percent in march per the ledger";
const CHUNK_UNCITED = "kanban plugin board column cards preserved verbatim settings block";

const rows = (edb: Database) =>
  edb
    .prepare(
      "SELECT id, chunk_id, cited_in_response, citation_score FROM chunk_retrievals ORDER BY id",
    )
    .all() as Array<{
    id: string;
    chunk_id: string;
    cited_in_response: number | null;
    citation_score: number | null;
  }>;

describe("citation inference (THE-170)", () => {
  it("rougeL: identical -> 1, disjoint -> 0, overlap in between", () => {
    expect(rougeL("alpha beta gamma", "alpha beta gamma")).toBe(1);
    expect(rougeL("alpha beta gamma", "delta epsilon zeta")).toBe(0);
    const mid = rougeL(CHUNK_CITED, TRANSCRIPT);
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(1);
    expect(rougeL(CHUNK_UNCITED, TRANSCRIPT)).toBeLessThan(0.05);
  });

  it("two-stage: judge stamps survivors, negatives stamp 0, other sessions untouched", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cB", CHUNK_UNCITED);
    seedRetrieval(edb, "r1", "cA", "s1");
    seedRetrieval(edb, "r2", "cB", "s1");
    seedRetrieval(edb, "r3", "cA", "s2"); // other session — must stay NULL

    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => ({ text: '{"cited": true, "score": 0.9}', model: "fake" }),
    });
    expect(stats).toMatchObject({
      scoped: 2,
      stage1Pass: 1,
      judged: 1,
      cited: 1,
      parseFailures: 0,
      aborted: false,
    });
    const r = rows(edb);
    expect(r.find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 1,
      citation_score: 0.9,
    });
    expect(r.find((x) => x.id === "r2")?.cited_in_response).toBe(0);
    expect(r.find((x) => x.id === "r3")?.cited_in_response).toBeNull();
  });

  it("kill switch: garbage judge output aborts survivor stamping, negatives still stamp", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cB", CHUNK_UNCITED);
    seedRetrieval(edb, "r1", "cA", "s1");
    seedRetrieval(edb, "r2", "cB", "s1");

    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => ({ text: "definitely not json", model: "fake" }),
    });
    expect(stats.aborted).toBe(true);
    expect(stats.parseFailures).toBe(1);
    const r = rows(edb);
    expect(r.find((x) => x.id === "r1")?.cited_in_response).toBeNull(); // clean rerun possible
    expect(r.find((x) => x.id === "r2")?.cited_in_response).toBe(0);
  });

  it("stage-1-only mode (no judge) stamps survivors cited=1 with the stage-1 score", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    seedRetrieval(edb, "r1", "cA", "s1");
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
    });
    expect(stats).toMatchObject({ scoped: 1, stage1Pass: 1, judged: 0, cited: 1 });
    const r = rows(edb)[0];
    expect(r?.cited_in_response).toBe(1);
    expect(r?.citation_score).toBeGreaterThan(0.05); // the rouge score, cosine absent
  });

  it("windowMs scope works when session ids are null", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    edb
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES ('r1', 'cA', ?, 'search_semantic', 'q', 1)",
      )
      .run(NOW);
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      windowMs: [NOW - 1000, NOW + 1000],
    });
    expect(stats.cited).toBe(1);
  });

  // THE-617 item 3 — the module-local MAX_JUDGED=25 had no override anywhere (unlike
  // reflect.ts's identically-shaped constant, which reflect's CLI already exposes via
  // --max-judged). Threaded the same way: an opts override here, --max-judged on the
  // citation-infer CLI.
  it("maxJudged caps how many stage-1 survivors get judged, overriding the default", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    const chunkIds = ["cA", "cB", "cC"];
    for (const id of chunkIds) {
      cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run(id, CHUNK_CITED);
      seedRetrieval(edb, `r-${id}`, id, "s1");
    }
    let judgeCalls = 0;
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      maxJudged: 2,
      judge: async () => {
        judgeCalls += 1;
        return { text: '{"cited": true, "score": 0.9}', model: "fake" };
      },
    });
    expect(stats.stage1Pass).toBe(3); // all three survive stage 1
    expect(stats.judged).toBe(2); // but only maxJudged of them are actually judged
    expect(judgeCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// The provenance axis (20260731_001). `cited_in_response`'s `1` conflated "the judge confirmed
// this against the transcript" with "it cleared the cheap stage-1 filter and no judge existed" —
// and every downstream reader (chunk_access_stats, contribution.ts, metrics.ts) counts `= 1`, so
// the absence of a gateway silently manufactures citations.
//
// This column separates the two WITHOUT changing a single existing number. The tests above are
// the proof of that half: they assert the exact prior cited_in_response values and all still pass
// untouched. The tests below pin the new half.
// ---------------------------------------------------------------------------------------------
const states = (edb: Database) =>
  edb
    .prepare("SELECT id, cited_in_response, citation_state FROM chunk_retrievals ORDER BY id")
    .all() as Array<{
    id: string;
    cited_in_response: number | null;
    citation_state: string | null;
  }>;

describe("citation provenance (citation_state)", () => {
  function seeded() {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cB", CHUNK_UNCITED);
    seedRetrieval(edb, "r1", "cA", "s1");
    seedRetrieval(edb, "r2", "cB", "s1");
    return { edb, cacheDb };
  }

  it("a judge-affirmed survivor is 'confirmed'; a stage-1 negative is 'rejected'", async () => {
    const { edb, cacheDb } = seeded();
    await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => ({ text: '{"cited": true, "score": 0.9}', model: "fake" }),
    });
    const s = states(edb);
    expect(s.find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 1,
      citation_state: "confirmed",
    });
    expect(s.find((x) => x.id === "r2")).toMatchObject({
      cited_in_response: 0,
      citation_state: "rejected",
    });
  });

  it("a judge that says NOT cited is 'rejected', not merely unstamped", async () => {
    const { edb, cacheDb } = seeded();
    await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => ({ text: '{"cited": false, "score": 0.1}', model: "fake" }),
    });
    expect(states(edb).find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 0,
      citation_state: "rejected",
    });
  });

  it("⭐ a stage-1-only survivor is 'candidate' — still counted, now visibly unjudged", async () => {
    // THE POINT OF THE COLUMN. cited_in_response stays 1, so chunk_access_stats /
    // contribution.ts / metrics.ts count it exactly as before — but the row no longer claims a
    // judge ever looked at it. Whether these should stop counting is a separate, evidence-gated
    // decision; this makes the question answerable.
    const { edb, cacheDb } = seeded();
    const stats = await inferCitations({ edb, cacheDb, transcript: TRANSCRIPT, sessionId: "s1" });
    expect(stats.judged).toBe(0);
    expect(states(edb).find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 1,
      citation_state: "candidate",
    });
  });

  it("makes 'how much of our citation signal was never judged?' a query", async () => {
    const { edb, cacheDb } = seeded();
    await inferCitations({ edb, cacheDb, transcript: TRANSCRIPT, sessionId: "s1" });
    const row = edb
      .prepare(
        `SELECT SUM(CASE WHEN citation_state = 'candidate' THEN 1 ELSE 0 END) AS unjudged,
                SUM(CASE WHEN cited_in_response = 1 THEN 1 ELSE 0 END)         AS counted
         FROM chunk_retrievals`,
      )
      .get() as { unjudged: number; counted: number };
    // Every citation this run produced was unjudged — invisible before this column existed.
    expect(row.counted).toBe(1);
    expect(row.unjudged).toBe(1);
  });

  it("the kill switch leaves BOTH columns NULL — a clean rerun, not a recorded verdict", async () => {
    const { edb, cacheDb } = seeded();
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => ({ text: "definitely not json", model: "fake" }),
    });
    expect(stats.aborted).toBe(true);
    const s = states(edb);
    expect(s.find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: null,
      citation_state: null,
    });
    // The stage-1 negative still stamps, and still records WHY.
    expect(s.find((x) => x.id === "r2")).toMatchObject({
      cited_in_response: 0,
      citation_state: "rejected",
    });
  });

  it("the DB refuses a state outside the declared vocabulary", async () => {
    // The CHECK is what makes 'candidate' mean something: an unknown state cannot be stored, so a
    // future writer cannot quietly invent a fifth meaning the readers do not handle.
    const { edb } = seeded();
    expect(() =>
      edb.prepare("UPDATE chunk_retrievals SET citation_state = 'probably' WHERE id = 'r1'").run(),
    ).toThrow();
    for (const ok of ["confirmed", "rejected", "candidate", "uncertain"]) {
      expect(() =>
        edb.prepare("UPDATE chunk_retrievals SET citation_state = ? WHERE id = 'r1'").run(ok),
      ).not.toThrow();
    }
  });
});
