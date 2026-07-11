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
});
