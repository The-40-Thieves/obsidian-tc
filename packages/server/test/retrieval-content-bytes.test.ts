// THE-585 (#12): content bytes hydrated at the two boundaries that waste it — duplicate
// hydration across streams (candidateAssembly) and the top-K cut (diversity/gatedRerank).
//
// This exercises a REAL graphSearch() call end-to-end, wires its onStageMetric callback into a
// real MetricsRecorder (not a shim), and asserts the VALUE off the scraped Prometheus exposition
// — the shape that would have caught the three dead gauges (PR #474) that were registered but
// fed by nothing. A registered-but-unfed counter is exactly the failure mode this test is here
// to rule out.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { MetricsRecorder } from "../src/metrics/registry";
import { graphSearch } from "../src/search/graph_search";
import type { StageMetric } from "../src/search/graph_search_stages/instrumentation";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function seedDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  return db;
}

function addChunk(db: Database, id: string, path: string, content: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

/** Extracts a single Prometheus sample's numeric value, or undefined if the series is absent. */
function sample(text: string, metric: string, vault: string, stage: string): number | undefined {
  const re = new RegExp(`^${metric}\\{vault="${vault}",stage="${stage}"\\} (\\S+)$`, "m");
  const m = text.match(re);
  return m ? Number(m[1]) : undefined;
}

describe("retrieval content-bytes instrumentation (THE-585 #12)", () => {
  it("shows bytesIn > bytesOut for the diversity stage's top-K cut, off the real exposition", async () => {
    const db = seedDb();
    // Six single-stream (seed-only) candidates with strictly increasing content length and
    // strictly decreasing similarity, so finalTopK keeps the two SHORTEST bodies and the top-K
    // cut is unambiguous: the survivors are the smallest-byte candidates, not merely fewer of
    // them by chance.
    const lens = [10, 20, 30, 40, 50, 60];
    const contents = lens.map((n) => "x".repeat(n));
    const sims = [0.99, 0.95, 0.9, 0.85, 0.8, 0.75];
    contents.forEach((content, i) => {
      addChunk(db, `c${i}`, `C${i}.md`, content, vd(sims[i] as number));
    });

    const recorder = new MetricsRecorder();
    const metrics: StageMetric[] = [];
    await graphSearch(db, {
      query: "q",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 6,
      finalTopK: 2,
      router: { enabled: false },
      lexical: { enabled: false },
      onStageMetric: (metric) => {
        metrics.push(metric);
        recorder.observeRetrievalStage("main", metric);
      },
    });

    // Sanity: the pipeline actually narrowed from 6 assembled candidates to 2 returned, which is
    // the precondition the ticket names ("a retrieval that assembles more candidates than it
    // returns").
    const diversityMetric = metrics.find((m) => m.stage === "diversity");
    expect(diversityMetric?.candidatesIn).toBe(6);
    expect(diversityMetric?.candidatesOut).toBe(2);

    const text = await recorder.metrics();
    const totalBytes = contents.reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0);
    const survivingBytes = contents
      .slice(0, 2)
      .reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0);

    const bytesIn = sample(
      text,
      "obsidian_tc_retrieval_content_bytes_in_total",
      "main",
      "diversity",
    );
    const bytesOut = sample(
      text,
      "obsidian_tc_retrieval_content_bytes_out_total",
      "main",
      "diversity",
    );
    expect(bytesIn).toBe(totalBytes);
    expect(bytesOut).toBe(survivingBytes);
    expect(bytesIn).toBeGreaterThan(bytesOut as number); // the wasted-I/O signal itself

    // candidateAssembly: single stream, no cross-stream duplicates in this fixture, so bytesIn
    // equals bytesOut here — a real value nonetheless, not a registered-but-unfed series.
    expect(
      sample(text, "obsidian_tc_retrieval_content_bytes_in_total", "main", "candidateAssembly"),
    ).toBe(totalBytes);
    expect(
      sample(text, "obsidian_tc_retrieval_content_bytes_out_total", "main", "candidateAssembly"),
    ).toBe(totalBytes);

    // gatedRerank falls through to plain projection (gatedRerank.enabled defaults false), so its
    // content passes through unchanged: bytesIn == bytesOut == what diversity let through.
    expect(
      sample(text, "obsidian_tc_retrieval_content_bytes_in_total", "main", "gatedRerank"),
    ).toBe(survivingBytes);
    expect(
      sample(text, "obsidian_tc_retrieval_content_bytes_out_total", "main", "gatedRerank"),
    ).toBe(survivingBytes);

    // A stage this item does NOT populate must create no series at all — not a registered zero,
    // an absent one, per StageMetric's optional bytesIn/bytesOut contract.
    expect(
      sample(text, "obsidian_tc_retrieval_content_bytes_in_total", "main", "seedGeneration"),
    ).toBeUndefined();
    expect(text).not.toMatch(
      /^obsidian_tc_retrieval_content_bytes_(in|out)_total\{vault="main",stage="seedGeneration"\}/m,
    );
  });
});
