// THE-632: the retrieval trace must be a PURE SIDE-CHANNEL.
//
// Same contract as onCoverage (THE-631) and onStageMetric (THE-465): setting `tracePath` may not
// filter, boost, reorder, or truncate anything. A diagnostic that perturbs the pipeline answers a
// question about itself, and the whole point of tracing the real path rather than a parallel debug
// one is that the answer describes production.
//
// This is also why diagnose_retrieval re-runs the SAME pipeline with tracing on, instead of the
// pipeline retaining per-chunk scores for later inspection: retention would cost every normal
// search, and a debug branch that is always live is the branch that drifts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { estimateCoverage, graphSearch } from "../src/search/graph_search";
import type {
  OnRetrievalTrace,
  RetrievalTraceRecord,
} from "../src/search/graph_search_stages/instrumentation";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";
const QUERY_VEC = [1, 0, 0, 0];

function vd(cos: number): number[] {
  return [cos, Math.sqrt(1 - cos * cos), 0, 0];
}

function addChunk(db: Database, id: string, path: string, content: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

function corpus(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  addChunk(db, "cA", "A.md", "dense answer no keyword here", vd(0.99));
  addChunk(db, "cB", "B.md", "quokka habitat notes", vd(0.98));
  addChunk(db, "cC", "C.md", "spacer text", vd(0.1));
  addChunk(db, "cL", "L.md", "quokka quokka quokka", vd(0.0));
  return db;
}

/** FTS5 required, not skipped — the lexical arm has to be live for this A/B to mean anything, and a
 *  suite that silently returns reports the side-channel property as HELD. Same contract as
 *  router-df-oracle.test.ts and lexical-sparse-acl.test.ts. */
function requireFts(db: Database): Database {
  if (!ensureChunkFts(db)) {
    throw new Error("FTS5 unavailable — the trace A/B cannot run. Refusing to pass vacuously.");
  }
  return db;
}

// THE-632 round 5: this file previously claimed "the trace contract is exercised end-to-end by the
// graph-search suites" and pinned only the shape of hand-built record literals. Neither held. No
// test anywhere set `traceNotePath` or `onRetrievalTrace` against the real pipeline — `rg` over
// test/ returned nothing — and asserting that an object literal you just wrote without a `score`
// key has no `score` key is a tautology that passes whatever production emits. The load-bearing
// property was therefore untested behind a filename saying it was tested. The A/B below is the
// assertion the file always claimed to make; the shape tests are kept but demoted to what they are.
describe("tracing does not perturb the pipeline (THE-632, the actual contract)", () => {
  it("results are IDENTICAL with tracing on and off", async () => {
    const opts = {
      query: "quokka",
      queryVec: QUERY_VEC,
      vaultId: VAULT,
      seedCount: 3,
      finalTopK: 10,
      router: { enabled: false },
    };
    const untraced = await graphSearch(requireFts(corpus()), opts);

    const records: RetrievalTraceRecord[] = [];
    const traced = await graphSearch(requireFts(corpus()), {
      ...opts,
      traceNotePath: "B.md",
      onRetrievalTrace: (r) => records.push(r),
    });

    // Non-empty FIRST. Two empty arrays are byte-identical, so without this the equality below is
    // satisfied by a pipeline that returned nothing — the same vacuity this file is being fixed for.
    expect(untraced.length).toBeGreaterThan(0);
    // Byte-identical, not merely same-length or same-set: ordering and every score field too.
    expect(JSON.stringify(traced)).toBe(JSON.stringify(untraced));
    // And the trace actually ran — otherwise the equality above is satisfied by doing nothing,
    // which is the exact failure mode this file previously shipped.
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((r) => r.present)).toBe(true);
  });

  it("pointing the trace at a DIFFERENT note does not change results either", async () => {
    const opts = {
      query: "quokka",
      queryVec: QUERY_VEC,
      vaultId: VAULT,
      seedCount: 3,
      finalTopK: 10,
      router: { enabled: false },
    };
    const atB: RetrievalTraceRecord[] = [];
    const atMissing: RetrievalTraceRecord[] = [];
    const b = await graphSearch(requireFts(corpus()), {
      ...opts,
      traceNotePath: "B.md",
      onRetrievalTrace: (r) => atB.push(r),
    });
    const missing = await graphSearch(requireFts(corpus()), {
      ...opts,
      traceNotePath: "does-not-exist.md",
      onRetrievalTrace: (r) => atMissing.push(r),
    });

    expect(b.length).toBeGreaterThan(0); // see the non-empty note above
    expect(JSON.stringify(b)).toBe(JSON.stringify(missing));
    // The traces DO differ — that is the point of the selector, and it proves both ran.
    expect(atB.some((r) => r.present)).toBe(true);
    expect(atMissing.some((r) => r.present)).toBe(false);
  });

  it("emits absent-not-zero from the REAL pipeline, not just from a literal", async () => {
    // The absent-not-zero rule asserted against production output. seedGeneration has no notion of
    // a score, so its record must OMIT the key rather than report 0 — an invented 0 reads as
    // "scored terribly" instead of "not scored here".
    const records: RetrievalTraceRecord[] = [];
    await graphSearch(requireFts(corpus()), {
      query: "quokka",
      queryVec: QUERY_VEC,
      vaultId: VAULT,
      seedCount: 3,
      finalTopK: 10,
      router: { enabled: false },
      traceNotePath: "B.md",
      onRetrievalTrace: (r) => records.push(r),
    });
    const seed = records.find((r) => r.stage === "seedGeneration");
    expect(seed).toBeDefined();
    expect(Object.hasOwn(seed ?? {}, "score")).toBe(false);
  });
});

// Below: shape-level pins over hand-built literals. These document the intended record shape and
// catch a careless interface edit, but they call no production code — they cannot substitute for
// the A/B above, and previously they were all this file had.
describe("RetrievalTraceRecord shape (THE-632)", () => {
  it("omits score/rank rather than defaulting them to 0", () => {
    // A stage with no notion of a score must not report `score: 0` — that reads as "scored
    // terribly" when the truth is "not scored here", and it is exactly the class of false signal
    // THE-688 was filed about one layer up.
    const seen: RetrievalTraceRecord[] = [];
    const emit: OnRetrievalTrace = (r) => seen.push(r);

    emit({
      stage: "candidateAssembly",
      present: false,
      chunksPresent: 0,
      candidatesIn: 40,
      candidatesOut: 12,
      note: "absent here means the note never entered the candidate pool",
    });

    const [rec] = seen;
    expect(rec).toBeDefined();
    expect(rec?.present).toBe(false);
    expect(rec?.chunksPresent).toBe(0);
    // The distinction that matters: the KEYS are absent, not present-and-zero.
    expect(Object.hasOwn(rec ?? {}, "score")).toBe(false);
    expect(Object.hasOwn(rec ?? {}, "rank")).toBe(false);
  });

  it("chunksPresent distinguishes partial survival from total loss", () => {
    // A note is many chunks. "1 of 7 survived" and "7 of 7 survived" are different diagnoses that a
    // boolean `present` collapses into the same answer.
    const partial: RetrievalTraceRecord = {
      stage: "diversity",
      present: true,
      chunksPresent: 1,
      candidatesIn: 30,
      candidatesOut: 10,
      score: 0.41,
      rank: 8,
    };
    expect(partial.present).toBe(true);
    expect(partial.chunksPresent).toBe(1);
    expect(partial.chunksPresent).toBeLessThan(7);
  });
});

describe("coverage estimate is unaffected by tracing (THE-631 x THE-632)", () => {
  it("estimateCoverage reads only the results, so a trace cannot move it", () => {
    // estimateCoverage is pure over the RESULT array. Tracing never touches that array, so this is
    // the cheap structural proof that turning tracing on cannot change what the caller is told
    // about coverage — the two side-channels stay independent.
    const results = [
      {
        chunk_id: "c1",
        path: "a.md",
        source: "seed" as const,
        hop: 0,
        via_edge: null,
        root_seed: null,
        rerank_score: 0.9,
      },
    ];
    const a = estimateCoverage(results, 5, { routedToSeedsOnly: false, expansionTruncated: false });
    const b = estimateCoverage(results, 5, { routedToSeedsOnly: false, expansionTruncated: false });
    expect(a).toEqual(b);
    expect(a.returned).toBe(1);
    expect(a.underfilled).toBe(true);
  });
});
