// Config-driven frontmatter metadata prior (authority boost). Ported from the retired KMS/vault-sync
// hardcoded prior (009_vault_search_priority.sql): additive boosts on the fused score for notes whose
// frontmatter matches a rule, applied POST-FUSION and clamped SUB-DOMINANT to the RRF score spread so
// the prior only tie-breaks — it can reorder near-neighbours but never lift a low-RRF note past a
// confident hit. Off by default (disabled / empty rules = exact no-op).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import {
  clampMetadataBoost,
  type GraphSearchResult,
  graphSearch,
} from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

// unit vector whose cosine with the [1,0,0,0] query equals c.
function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function db0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  // Empty edge table => no graph expansion; the fused pool is exactly the seed set (RRF rank scores
  // are then the deterministic 1/(k+rank), which makes the clamp arithmetic checkable).
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  db.exec(`CREATE TABLE notes (vault_id TEXT NOT NULL, path TEXT NOT NULL, frontmatter TEXT);`);
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

function addNote(db: Database, path: string, frontmatter: Record<string, unknown> | null): void {
  db.prepare("INSERT INTO notes (vault_id, path, frontmatter) VALUES (?, ?, ?)").run(
    VAULT,
    path,
    frontmatter === null ? null : JSON.stringify(frontmatter),
  );
}

// Six seeds at descending cosine => deterministic base RRF scores 1/(10+rank): index 0 is the
// confident top hit, index 5 the weakest. The note at index 5 carries a matching frontmatter rule.
function sixSeedVault(bottomFrontmatter: Record<string, unknown>): Database {
  const db = db0();
  const cosines = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7];
  cosines.forEach((c, i) => {
    addChunk(db, `c${i}`, `n${i}.md`, vd(c));
    addNote(db, `n${i}.md`, i === 5 ? bottomFrontmatter : { type: "reference" });
  });
  return db;
}

const COMMON = {
  query: "q",
  queryVec: [1, 0, 0, 0] as number[],
  vaultId: VAULT,
  finalTopK: 10,
  router: { enabled: false },
  lexical: { enabled: false },
};

const RULES = [
  { field: "status", value: "locked", boost: 0.02 },
  { field: "type", value: "decision", boost: 0.015 },
  { field: "type", value: "project", boost: 0.01 },
  { field: "status", value: "active", boost: 0.005 },
];

const pos = (res: GraphSearchResult[], id: string): number =>
  res.findIndex((r) => r.chunk_id === id);
const scoreOf = (res: GraphSearchResult[], id: string): number =>
  res.find((r) => r.chunk_id === id)?.rerank_score ?? Number.NaN;

describe("metadata prior — boost math + additive composition", () => {
  it("a matching frontmatter rule lifts a weak note by exactly its (clamped) boost, re-sorting it up", async () => {
    // Bottom note is a type:decision (+0.015). Base gap to its upper neighbours is small enough that
    // 0.015 (< the clamp cap here) carries it past two of them — but not past the confident top.
    const db = sixSeedVault({ type: "decision" });
    const off = await graphSearch(db, COMMON);
    const on = await graphSearch(db, {
      ...COMMON,
      metadataPrior: { enabled: true, rules: RULES },
    });

    // Base spread over the seed pool, and the clamp cap the prior stays under.
    const spread = scoreOf(off, "c0") - scoreOf(off, "c5");
    const expectedBoost = clampMetadataBoost(0.015, spread, 0.5);
    // Additive composition: the boosted chunk's score is EXACTLY base + clamped boost.
    expect(scoreOf(on, "c5") - scoreOf(off, "c5")).toBeCloseTo(expectedBoost, 10);
    // Non-matching notes are untouched (reference gets no rule).
    expect(scoreOf(on, "c3")).toBeCloseTo(scoreOf(off, "c3"), 10);
    // Re-sort: the decision note climbed from last to above its weaker neighbours...
    expect(pos(on, "c5")).toBeLessThan(pos(off, "c5"));
    expect(pos(on, "c5")).toBeLessThan(pos(on, "c3"));
    // ...but the confident top hit is never displaced.
    expect(pos(on, "c0")).toBe(0);
  });
});

describe("metadata prior — sub-dominance clamp", () => {
  it("clampMetadataBoost bounds |boost| to clampFraction of the spread (frac itself in [0,1])", () => {
    // Within the cap: passed through untouched.
    expect(clampMetadataBoost(0.003, 0.02, 0.5)).toBeCloseTo(0.003, 12);
    // Over the cap (0.5 * 0.02 = 0.01): clamped down.
    expect(clampMetadataBoost(100, 0.02, 0.5)).toBeCloseTo(0.01, 12);
    // Symmetric for a negative (penalty) rule.
    expect(clampMetadataBoost(-100, 0.02, 0.5)).toBeCloseTo(-0.01, 12);
    // clampFraction is clamped to [0,1]: >1 cannot let the prior exceed the full spread; <0 is zero.
    expect(clampMetadataBoost(100, 0.02, 5)).toBeCloseTo(0.02, 12);
    expect(clampMetadataBoost(100, 0.02, -1)).toBe(0);
    // A zero/negative spread yields no boost (nothing to tie-break within).
    expect(clampMetadataBoost(100, 0, 0.5)).toBe(0);
  });

  it("an absurd boost cannot override RRF: the confident top hit keeps rank 1", async () => {
    // status:locked with a pathological +100 boost. The clamp caps it at 0.5 * spread, so even the
    // weakest seed cannot climb past the top — the prior stays a tie-break, never an override.
    const db = sixSeedVault({ status: "locked" });
    const off = await graphSearch(db, COMMON);
    const on = await graphSearch(db, {
      ...COMMON,
      metadataPrior: {
        enabled: true,
        rules: [{ field: "status", value: "locked", boost: 100 }],
        clampFraction: 0.5,
      },
    });
    const spread = scoreOf(off, "c0") - scoreOf(off, "c5");
    const cap = clampMetadataBoost(100, spread, 0.5);
    // The boost is clamped to the cap, not applied raw...
    expect(scoreOf(on, "c5") - scoreOf(off, "c5")).toBeCloseTo(cap, 10);
    // ...so the boosted score stays strictly below the untouched top hit.
    expect(scoreOf(on, "c5")).toBeLessThan(scoreOf(on, "c0"));
    expect(pos(on, "c0")).toBe(0);
    expect(on.length).toBe(off.length);
  });
});

describe("metadata prior — off by default is an exact no-op", () => {
  it("disabled, absent, and empty-rules all reproduce the baseline order and scores byte-for-byte", async () => {
    const db = sixSeedVault({ status: "locked", type: "decision" });
    const baseline = await graphSearch(db, COMMON);
    const disabled = await graphSearch(db, {
      ...COMMON,
      metadataPrior: { enabled: false, rules: RULES },
    });
    const emptyRules = await graphSearch(db, {
      ...COMMON,
      metadataPrior: { enabled: true, rules: [] },
    });

    for (const variant of [disabled, emptyRules]) {
      expect(variant.map((r) => r.chunk_id)).toEqual(baseline.map((r) => r.chunk_id));
      for (const r of baseline) {
        expect(scoreOf(variant, r.chunk_id)).toBe(scoreOf(baseline, r.chunk_id));
      }
    }
  });
});
