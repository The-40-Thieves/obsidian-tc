// THE-233 — bubble-safe activation composition wiring into graphSearch.finalize (score_merge path).
// Proves the opt is STRICTLY off by default (non-behavioral even with activationFor present) and,
// when enabled, folds the activation signal into the fused order via a single bubble pass — every
// item shifts by at most one position. With a null reranker, rerankWithScores degrades to the fused
// order with synthetic descending scores, so the trusted order under test is deterministic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { type GraphSearchResult, graphSearch } from "../src/search/graph_search";
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

function db0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  // Empty edge table so literal expansion runs (and finds nothing) instead of throwing.
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  return db;
}

function addChunk(db: Database, id: string, path: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `body ${id}`, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

const pos = (res: GraphSearchResult[], id: string): number =>
  res.findIndex((r) => r.chunk_id === id);

describe("bubble-safe activation composition wiring (THE-233)", () => {
  // Three seeds with distinct cosines fix the fused order cA > cB > cC. cC carries strong
  // activation (1.0 -> 1.2x); the others are inert (no activation row -> 0.5 -> 1.0x).
  function seed(): Database {
    const db = db0();
    addChunk(db, "cA", "A.md", vd(0.95));
    addChunk(db, "cB", "B.md", vd(0.9));
    addChunk(db, "cC", "C.md", vd(0.85));
    return db;
  }
  const common = {
    query: "q",
    queryVec: [1, 0, 0, 0],
    vaultId: VAULT,
    seedCount: 3,
    finalTopK: 10,
    fusionMode: "score_merge" as const,
    router: { enabled: false },
    lexical: { enabled: false },
    reranker: null,
  };
  const activationFor = (id: string) => (id === "cC" ? 1.0 : null);

  it("is non-behavioral when disabled — activationFor present but bubbleSafe off changes nothing", async () => {
    const baseline = await graphSearch(seed(), common); // no activationFor at all
    const disabledDefault = await graphSearch(seed(), { ...common, activationFor }); // opt absent
    const disabledExplicit = await graphSearch(seed(), {
      ...common,
      activationFor,
      bubbleSafe: { enabled: false, k: 0.4 },
    });
    const ids = (r: GraphSearchResult[]) => r.map((x) => x.chunk_id);
    expect(ids(baseline)).toEqual(["cA", "cB", "cC"]); // trusted fused order
    expect(ids(disabledDefault)).toEqual(ids(baseline)); // activationFor alone is inert
    expect(ids(disabledExplicit)).toEqual(ids(baseline)); // enabled:false is inert
  });

  it("when enabled, the activation signal moves the boosted item up exactly one position", async () => {
    const off = await graphSearch(seed(), { ...common, activationFor });
    const on = await graphSearch(seed(), {
      ...common,
      activationFor,
      bubbleSafe: { enabled: true },
    });
    // cC's 1.2x multiplier overtakes cB (adjusted 0.98*1.2 > 0.99): cC advances one slot.
    expect(on.map((x) => x.chunk_id)).toEqual(["cA", "cC", "cB"]);
    // Bound holds: no item shifted more than one index versus the disabled order.
    for (const id of ["cA", "cB", "cC"]) {
      expect(Math.abs(pos(on, id) - pos(off, id))).toBeLessThanOrEqual(1);
    }
    expect(on.length).toBe(off.length);
  });

  it("a smaller k suppresses the swap the default k would make (k threads through)", async () => {
    // cC base 0.98 vs cB 0.99: swap iff 0.98(1+0.5k) > 0.99(1-0.5k) <=> k > ~0.0102.
    // k=0.005 is below that threshold, so the fused order is preserved even when enabled.
    const on = await graphSearch(seed(), {
      ...common,
      activationFor,
      bubbleSafe: { enabled: true, k: 0.005 },
    });
    expect(on.map((x) => x.chunk_id)).toEqual(["cA", "cB", "cC"]);
  });

  // THE-447: the DEFAULT graph_rrf/convex path projects directly (bypassing finalize). These pin
  // that the composition is now pre-plumbed there too — strictly off by default, and bounded when on.
  describe("default graph_rrf path (THE-447 pre-plumb)", () => {
    const rrf = { ...common, fusionMode: "graph_rrf" as const };
    const ids = (r: GraphSearchResult[]) => r.map((x) => x.chunk_id);

    it("is byte-identical when disabled (activationFor present, opt off) on the default path", async () => {
      const baseline = await graphSearch(seed(), rrf); // no activationFor
      const withActInert = await graphSearch(seed(), { ...rrf, activationFor }); // opt absent
      const explicitOff = await graphSearch(seed(), {
        ...rrf,
        activationFor,
        bubbleSafe: { enabled: false, k: 0.4 },
      });
      expect(ids(withActInert)).toEqual(ids(baseline));
      expect(ids(explicitOff)).toEqual(ids(baseline));
    });

    it("when enabled, folds activation into the default projection within the one-swap bound", async () => {
      const off = await graphSearch(seed(), { ...rrf, activationFor });
      const on = await graphSearch(seed(), {
        ...rrf,
        activationFor,
        bubbleSafe: { enabled: true },
      });
      // one-swap bound holds versus the disabled order, and the boosted item never moves DOWN.
      for (const id of ["cA", "cB", "cC"]) {
        expect(Math.abs(pos(on, id) - pos(off, id))).toBeLessThanOrEqual(1);
      }
      expect(pos(on, "cC")).toBeLessThanOrEqual(pos(off, "cC"));
      expect(on.length).toBe(off.length);
    });
  });
});
