// THE-221 Phase 1 — temporal retrieval. Pins: (1) the precision-first parser (prepositioned
// months/years route, bare title-style tokens NEVER route, ISO dates and relative forms are
// unambiguous); (2) filename-date extraction; (3) the conditional stream in graphSearch — a dated
// note invisible to the vector seeds is surfaced with source "temporal" on a temporal query, and
// the stream stays empty (static behaviour) when disabled or when the query has no temporal
// intent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { graphSearch } from "../src/search/graph_search";
import { noteDateMs, parseTemporalIntent } from "../src/search/temporal";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";
const QUERY_VEC = [1, 0, 0, 0];
// Fixed "now": 2026-07-11T12:00:00Z.
const NOW = Date.UTC(2026, 6, 11, 12);

function vd(cos: number): number[] {
  return [cos, Math.sqrt(1 - cos * cos), 0, 0];
}

function addChunk(db: Database, id: string, path: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `body ${id}`, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

describe("THE-221 parseTemporalIntent", () => {
  it("routes ISO dates with or without a preposition", () => {
    const r = parseTemporalIntent("what happened on 2026-05-05", NOW);
    expect(r).not.toBeNull();
    expect(new Date(r?.start ?? 0).toISOString().slice(0, 10)).toBe("2026-05-05");
    expect(parseTemporalIntent("the 2026-05-05 vault color work", NOW)).not.toBeNull();
  });

  it("routes prepositioned months and years; infers the current year", () => {
    const june = parseTemporalIntent("what did we decide about modal in june", NOW);
    expect(new Date(june?.start ?? 0).toISOString().slice(0, 7)).toBe("2026-06");
    const y = parseTemporalIntent("decisions made during 2025", NOW);
    expect(new Date(y?.start ?? 0).toISOString().slice(0, 4)).toBe("2025");
  });

  it("NEVER routes bare title-style month/year tokens (precision-first)", () => {
    expect(parseTemporalIntent("AI Sovereignty Platform Research 2026", NOW)).toBeNull();
    expect(parseTemporalIntent("Creative Identity Map - May 2026 note", NOW)).toBeNull();
    expect(parseTemporalIntent("what is the six-query research plan", NOW)).toBeNull();
  });

  it("handles early/mid/late month and relative forms deterministically", () => {
    const early = parseTemporalIntent("the stack decision from early july", NOW);
    expect(new Date(early?.start ?? 0).toISOString().slice(0, 10)).toBe("2026-07-01");
    const lastWeek = parseTemporalIntent("the retrieval work last week", NOW);
    expect(lastWeek?.end).toBe(NOW - 7 * 86_400_000);
    const since = parseTemporalIntent("everything since june 2026", NOW);
    expect(since?.end).toBe(NOW);
  });
});

describe("THE-221 noteDateMs", () => {
  it("extracts the leading filename date; null otherwise", () => {
    expect(noteDateMs("01-daily/2030-01-01.md")).toBe(Date.UTC(2030, 0, 1));
    expect(noteDateMs("09-reference/decisions/2026-06-12-example-decision.md")).toBe(
      Date.UTC(2026, 5, 12),
    );
    expect(noteDateMs("02-projects/Undated Example.md")).toBeNull();
  });
});

describe("THE-221 temporal stream in graphSearch", () => {
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
    addChunk(db, "cS", "S.md", vd(0.95)); // dense seed, undated
    addChunk(db, "cD", "01-daily/2030-01-01.md", vd(0.05)); // dated, invisible to vector seeds
    addChunk(db, "cE", "09-reference/2026-06-20-other.md", vd(0.05)); // dated, out of range
    return db;
  }

  const run = (db: Database, enabled: boolean, query: string) =>
    graphSearch(db, {
      query,
      queryVec: QUERY_VEC,
      vaultId: VAULT,
      seedCount: 1,
      finalTopK: 10,
      router: { enabled: false },
      ...(enabled ? { temporal: { enabled: true, nowMs: NOW } } : {}),
    });

  it("surfaces an in-range dated note as source temporal; out-of-range stays absent", async () => {
    const db = corpus();
    const res = await run(db, true, "what happened on 2030-01-01");
    const hit = res.find((r) => r.path === "01-daily/2030-01-01.md");
    expect(hit?.source).toBe("temporal");
    expect(res.some((r) => r.path === "09-reference/2026-06-20-other.md")).toBe(false);
  });

  it("stays empty when disabled or when the query has no temporal intent", async () => {
    const db = corpus();
    const off = await run(db, false, "what happened on 2026-05-05");
    expect(off.some((r) => r.source === "temporal")).toBe(false);
    const noIntent = await run(db, true, "vault color scheme work");
    expect(noIntent.some((r) => r.source === "temporal")).toBe(false);
  });
});
