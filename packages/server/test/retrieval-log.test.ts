// THE-230 — serve-path retrieval logging into the experiential store. Proves the logger
// appends one chunk_retrievals row per hit with rank/score/surface/query, leaves the outcome
// axis null, never throws (errors go to onError), and feeds recomputeActivation end-to-end
// (log -> recompute -> cached_activation_score present).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { recomputeActivation } from "../src/experiential/activation";
import { createRetrievalLogger } from "../src/experiential/log";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
// THE-538: derived from the manifest rather than hand-listed. The hand-kept copy had already
// drifted (it named 3 of the chain's files), and the drift only surfaces when a new migration adds
// a column the logger writes — at which point this file fails for a reason that looks unrelated.
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

interface Row {
  chunk_id: string;
  retrieved_at: number;
  session_id: string | null;
  caller: string | null;
  surface_type: string;
  query_text: string;
  rank_in_results: number;
  rerank_score: number | null;
  cited_in_response: number | null;
  citation_score: number | null;
  feedback: number | null;
}

describe("retrieval logging (THE-230)", () => {
  it("appends one row per hit with rank, score, surface, and query text", () => {
    const db = edb0();
    const log = createRetrievalLogger(db, { now: () => NOW });
    log({
      queryText: "vault health reconcile",
      surfaceType: "vault_graph_search",
      hits: [
        { chunkId: "c1", rank: 1, score: 0.91 },
        { chunkId: "c2", rank: 2, score: 0.75 },
        { chunkId: "c3", rank: 3 },
      ],
    });
    const rows = db
      .prepare("SELECT * FROM chunk_retrievals ORDER BY rank_in_results")
      .all() as Row[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      chunk_id: "c1",
      retrieved_at: NOW,
      session_id: null,
      caller: null,
      surface_type: "vault_graph_search",
      query_text: "vault health reconcile",
      rank_in_results: 1,
      rerank_score: 0.91,
    });
    // The judgement axes ride null until their writers land (THE-170 / feedback surface). The
    // `outcome` column that used to be asserted here was retired in 20260806_001 (THE-718).
    expect(rows[0]?.cited_in_response).toBeNull();
    expect(rows[0]?.citation_score).toBeNull();
    expect(rows[0]?.feedback).toBeNull();
    expect(rows[2]?.rerank_score).toBeNull();
  });

  it("empty hit lists are a no-op and distinct events accumulate", () => {
    const db = edb0();
    const log = createRetrievalLogger(db, { now: () => NOW });
    log({ queryText: "no hits", surfaceType: "search_semantic", hits: [] });
    log({
      queryText: "q1",
      surfaceType: "search_semantic",
      hits: [{ chunkId: "c1", rank: 1, score: 0.5 }],
    });
    log({
      queryText: "q2",
      surfaceType: "search_vault",
      sessionId: "s-abc",
      hits: [{ chunkId: "c1", rank: 1, score: 0.6 }],
    });
    const rows = db.prepare("SELECT * FROM chunk_retrievals").all() as Row[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.surface_type).sort()).toEqual(["search_semantic", "search_vault"]);
    expect(rows.find((r) => r.query_text === "q2")?.session_id).toBe("s-abc");
  });

  it("THE-568: stamps the calling principal into the new caller column", () => {
    const db = edb0();
    const log = createRetrievalLogger(db, { now: () => NOW });
    log({
      queryText: "q",
      surfaceType: "vault_graph_search",
      caller: "agent-a",
      hits: [{ chunkId: "c1", rank: 1, score: 0.5 }],
    });
    log({
      queryText: "q2",
      surfaceType: "vault_graph_search",
      hits: [{ chunkId: "c2", rank: 1, score: 0.5 }],
    });
    const rows = db.prepare("SELECT chunk_id, caller FROM chunk_retrievals").all() as Row[];
    expect(rows.find((r) => r.chunk_id === "c1")?.caller).toBe("agent-a");
    // no caller supplied -> null, not "undefined" or a crash (nullable by design).
    expect(rows.find((r) => r.chunk_id === "c2")?.caller).toBeNull();
  });

  it("never throws: a broken store reports to onError and the caller survives", () => {
    const db = edb0();
    db.exec("DROP TABLE chunk_retrievals");
    let seen: unknown;
    // chunk_retrievals is gone, so the prepared insert fails at logger-construction time —
    // model the cli.ts guard: construction failure is also swallowed into onError.
    let logger: ReturnType<typeof createRetrievalLogger> = () => {};
    try {
      logger = createRetrievalLogger(db, {
        now: () => NOW,
        onError: (e) => {
          seen = e;
        },
      });
    } catch (e) {
      seen = e;
    }
    expect(() =>
      logger({
        queryText: "q",
        surfaceType: "search_semantic",
        hits: [{ chunkId: "c1", rank: 1 }],
      }),
    ).not.toThrow();
    expect(seen).toBeDefined();
  });

  it("logged events feed the activation recompute end-to-end", () => {
    const db = edb0();
    const log = createRetrievalLogger(db, { now: () => NOW });
    log({
      queryText: "recent hot chunk",
      surfaceType: "search_semantic",
      hits: [{ chunkId: "hot", rank: 1, score: 0.9 }],
    });
    const stats = recomputeActivation(db, NOW + 3_600_000);
    expect(stats.chunks).toBe(1);
    const state = db
      .prepare(
        "SELECT cached_activation_score, frequency FROM vault_object_state WHERE object_id = ?",
      )
      .get("hot") as { cached_activation_score: number; frequency: number };
    expect(state.frequency).toBe(1);
    expect(state.cached_activation_score).toBeGreaterThan(0.5); // fresh access -> above neutral
  });
});
