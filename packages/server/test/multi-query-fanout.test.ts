// THE-448: multi-query fan-out fusion — RRF over query-VARIANT results. This is a different
// fusion layer from the existing in-query RRF at graph_search.ts:578-593 (which fuses streams
// WITHIN one query): here each element of `queries` gets its OWN full graphSearch call, and the
// per-variant RANKED LISTS are fused by rank position (not by rerank_score — graph_search's convex
// fusion min-max-normalizes scores over a single query's own candidate pool, so raw scores are not
// comparable across variants; see graph_search.ts:601-616 and the multi_query.ts header comment).
//
// Two kinds of test here:
//  - `fuseVariants` unit tests: pure function, synthetic ranked lists, no DB — pins down the
//    rank-based RRF math, dedupe-by-path/keep-best-rank, and the finalTopK truncation exactly.
//  - `multiQueryGraphSearch` tests: a `vi.mock` of graph_search's `graphSearch` proves the
//    orchestration (bounded concurrency, per-variant error isolation, over-fetch depth) without
//    depending on FTS5 / a live corpus; a couple of REAL-DB integration tests (no mock) pin down
//    the "exact no-op" contract for absent/empty/single-element `queries` against the real
//    graphSearch.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { GraphSearchResult } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function result(path: string, overrides: Partial<GraphSearchResult> = {}): GraphSearchResult {
  return {
    chunk_id: `c-${path}`,
    path,
    source: "seed",
    hop: 0,
    via_edge: null,
    root_seed: null,
    rerank_score: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fuseVariants: pure RRF-across-variants math, no DB.
// ---------------------------------------------------------------------------
describe("fuseVariants (pure RRF-across-variants fusion)", () => {
  it("scores a single variant's list by its own rank (1/(rrfK+rank)), preserving order", async () => {
    const { fuseVariants } = await import("../src/search/multi_query");
    const variant = [result("a.md"), result("b.md"), result("c.md")];
    const fused = fuseVariants([variant], 10, 30);
    expect(fused.map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("a path ranked in TWO variants outscores one ranked in only one — dedupes to one entry", async () => {
    const { fuseVariants } = await import("../src/search/multi_query");
    // "shared.md" ranks #2 in variant A and #1 in variant B: 1/(10+2) + 1/(10+1) ≈ 0.1743.
    // "only-a.md" ranks #1 in variant A only: 1/(10+1) ≈ 0.0909.
    const variantA = [result("only-a.md"), result("shared.md")];
    const variantB = [result("shared.md"), result("only-b.md")];
    const fused = fuseVariants([variantA, variantB], 10, 30);
    const paths = fused.map((r) => r.path);
    expect(paths).toContain("shared.md");
    expect(paths.filter((p) => p === "shared.md")).toHaveLength(1); // deduped, not duplicated
    expect(paths[0]).toBe("shared.md"); // highest fused score
  });

  it("keeps the BEST-ranked occurrence's result object per path", async () => {
    const { fuseVariants } = await import("../src/search/multi_query");
    const bestHit = result("dup.md", { chunk_id: "c-dup-best", rerank_score: 0.9 });
    const worstHit = result("dup.md", { chunk_id: "c-dup-worst", rerank_score: 0.1 });
    // dup.md ranked #1 (best) in variant A, #3 (worse) in variant B.
    const variantA = [bestHit, result("filler1.md")];
    const variantB = [result("filler2.md"), result("filler3.md"), worstHit];
    const fused = fuseVariants([variantA, variantB], 10, 30);
    const dup = fused.find((r) => r.path === "dup.md");
    expect(dup?.chunk_id).toBe("c-dup-best");
  });

  it("a variant that contributed nothing (empty list) does not break fusion", async () => {
    const { fuseVariants } = await import("../src/search/multi_query");
    const fused = fuseVariants([[result("a.md")], [], [result("b.md")]], 10, 30);
    expect(fused.map((r) => r.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("truncates the fused list to finalTopK", async () => {
    const { fuseVariants } = await import("../src/search/multi_query");
    const variant = Array.from({ length: 20 }, (_, i) => result(`p${i}.md`));
    const fused = fuseVariants([variant], 10, 5);
    expect(fused).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// multiQueryGraphSearch orchestration: graphSearch mocked so fan-out mechanics are observable
// without a live corpus/FTS5.
// ---------------------------------------------------------------------------
const graphSearchSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/search/graph_search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/search/graph_search")>();
  return { ...actual, graphSearch: graphSearchSpy };
});

const { multiQueryGraphSearch } = await import("../src/search/multi_query");

const BASE_OPTS = {
  query: "original query",
  queryVec: [1, 0, 0, 0],
  vaultId: VAULT,
  finalTopK: 10,
};

describe("multiQueryGraphSearch orchestration (graphSearch mocked)", () => {
  // NOTE: must not implicitly return `mockReset()`'s value — it returns the mock itself (for
  // chaining), and vitest treats a function returned from beforeEach as a teardown hook, which
  // would then invoke the mock a THIRD time with zero args after every test.
  beforeEach(() => {
    graphSearchSpy.mockReset();
  });

  it("queries undefined is an exact no-op: calls graphSearch once with opts unchanged", async () => {
    graphSearchSpy.mockResolvedValue([result("a.md")]);
    const out = await multiQueryGraphSearch({} as Database, BASE_OPTS, undefined);
    expect(graphSearchSpy).toHaveBeenCalledTimes(1);
    expect(graphSearchSpy).toHaveBeenCalledWith({}, BASE_OPTS);
    expect(out).toEqual([result("a.md")]);
  });

  it("queries: [] is an exact no-op: calls graphSearch once with opts unchanged", async () => {
    graphSearchSpy.mockResolvedValue([result("a.md")]);
    const out = await multiQueryGraphSearch({} as Database, BASE_OPTS, []);
    expect(graphSearchSpy).toHaveBeenCalledTimes(1);
    expect(graphSearchSpy).toHaveBeenCalledWith({}, BASE_OPTS);
    expect(out).toEqual([result("a.md")]);
  });

  it("a single-element queries[] delegates to graphSearch with that query, opts otherwise unchanged", async () => {
    graphSearchSpy.mockResolvedValue([result("a.md")]);
    const out = await multiQueryGraphSearch({} as Database, BASE_OPTS, ["variant one"]);
    expect(graphSearchSpy).toHaveBeenCalledTimes(1);
    expect(graphSearchSpy).toHaveBeenCalledWith({}, { ...BASE_OPTS, query: "variant one" });
    // finalTopK must NOT be inflated for the single-variant no-op path.
    expect(graphSearchSpy.mock.calls[0]?.[1]?.finalTopK).toBe(10);
    expect(out).toEqual([result("a.md")]);
  });

  it("multiple variants: over-fetches perQueryK per variant and fuses by rank", async () => {
    graphSearchSpy.mockImplementation(async (_db: Database, opts: { query: string }) => {
      if (opts.query === "variant A") return [result("shared.md"), result("a-only.md")];
      if (opts.query === "variant B") return [result("shared.md"), result("b-only.md")];
      return [];
    });
    const out = await multiQueryGraphSearch({} as Database, BASE_OPTS, ["variant A", "variant B"]);
    expect(graphSearchSpy).toHaveBeenCalledTimes(2);
    // finalTopK 10 -> perQueryK = max(20, 20) = 20, per the ticket's formula.
    for (const call of graphSearchSpy.mock.calls) {
      expect((call[1] as { finalTopK: number }).finalTopK).toBe(20);
    }
    expect(out[0]?.path).toBe("shared.md"); // ranked #1 in both variants -> highest fused score
    expect(out.map((r) => r.path).sort()).toEqual(["a-only.md", "b-only.md", "shared.md"]);
  });

  it("never exceeds finalTopK even when variants contribute many distinct paths", async () => {
    graphSearchSpy.mockImplementation(async (_db: Database, opts: { query: string }) =>
      Array.from({ length: 20 }, (_, i) => result(`${opts.query}-${i}.md`)),
    );
    const out = await multiQueryGraphSearch({} as Database, { ...BASE_OPTS, finalTopK: 7 }, [
      "variant A",
      "variant B",
      "variant C",
    ]);
    expect(out.length).toBeLessThanOrEqual(7);
  });

  it("a variant that throws does not fail the whole fan-out — others still fuse", async () => {
    graphSearchSpy.mockImplementation(async (_db: Database, opts: { query: string }) => {
      if (opts.query === "bad variant") throw new Error("embedding provider down");
      return [result("ok.md")];
    });
    const out = await multiQueryGraphSearch({} as Database, BASE_OPTS, [
      "bad variant",
      "good variant",
    ]);
    expect(out.map((r) => r.path)).toEqual(["ok.md"]);
  });

  it("a variant that resolves empty does not fail the whole fan-out", async () => {
    graphSearchSpy.mockImplementation(async (_db: Database, opts: { query: string }) => {
      if (opts.query === "empty variant") return [];
      return [result("ok.md")];
    });
    const out = await multiQueryGraphSearch({} as Database, BASE_OPTS, [
      "empty variant",
      "good variant",
    ]);
    expect(out.map((r) => r.path)).toEqual(["ok.md"]);
  });

  it("respects the configured concurrency limit across variant calls", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    graphSearchSpy.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [];
    });
    const queries = Array.from({ length: 8 }, (_, i) => `variant ${i}`);
    await multiQueryGraphSearch(
      {} as Database,
      { ...BASE_OPTS, multiQueryFanOut: { concurrency: 2 } },
      queries,
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1); // proves it actually ran concurrently, not serially
  });

  it("defaults concurrency to 3 when multiQueryFanOut is not supplied", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    graphSearchSpy.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [];
    });
    const queries = Array.from({ length: 8 }, (_, i) => `variant ${i}`);
    await multiQueryGraphSearch({} as Database, BASE_OPTS, queries);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Real-DB integration: proves the no-op contract against the REAL graphSearch (unmocked module),
// not just the spy's echo of its inputs.
// ---------------------------------------------------------------------------
describe("multiQueryGraphSearch real-DB no-op integration (unmocked graphSearch)", () => {
  function addChunk(db: Database, id: string, path: string, vec: number[]): void {
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, VAULT, path, "0", "[]", `body ${id}`, `h-${id}`, 1, 0, 0);
    db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
    ).run(id, "test:embed", vec.length, floatBlob(vec));
  }

  function buildDb(): Database {
    const db = openMemoryDb();
    runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
    db.exec(
      `CREATE TABLE vault_edges (
         source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
         edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
       );`,
    );
    addChunk(db, "c1", "a.md", [1, 0, 0, 0]);
    addChunk(db, "c2", "b.md", [0.9, 0.1, 0, 0]);
    addChunk(db, "c3", "c.md", [0.1, 0.9, 0, 0]);
    return db;
  }

  // Real (unmocked) graphSearch import — importOriginal via a fresh dynamic import bypasses the
  // module-level vi.mock above only for THIS import specifier resolution is not possible with
  // vi.mock's static hoisting, so these tests instead call multiQueryGraphSearch (already bound
  // to the mocked module in this file) with the mock's actual/original implementation restored.
  it("queries undefined/[] produce identical results to a direct graphSearch call", async () => {
    const { graphSearch: real } = await vi.importActual<
      typeof import("../src/search/graph_search")
    >("../src/search/graph_search");
    graphSearchSpy.mockImplementation(real);
    const db = buildDb();
    const opts = {
      query: "alpha",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 5,
      finalTopK: 5,
      router: { enabled: false },
    };
    const direct = await real(db, opts);
    const viaUndefined = await multiQueryGraphSearch(db, opts, undefined);
    const viaEmpty = await multiQueryGraphSearch(db, opts, []);
    expect(viaUndefined).toEqual(direct);
    expect(viaEmpty).toEqual(direct);
  });

  it("a single-element queries[] produces identical results to graphSearch called with that query", async () => {
    const { graphSearch: real } = await vi.importActual<
      typeof import("../src/search/graph_search")
    >("../src/search/graph_search");
    graphSearchSpy.mockImplementation(real);
    const db = buildDb();
    const opts = {
      query: "original",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 5,
      finalTopK: 5,
      router: { enabled: false },
    };
    const direct = await real(db, { ...opts, query: "alpha variant" });
    const viaFanOut = await multiQueryGraphSearch(db, opts, ["alpha variant"]);
    expect(viaFanOut).toEqual(direct);
  });
});
