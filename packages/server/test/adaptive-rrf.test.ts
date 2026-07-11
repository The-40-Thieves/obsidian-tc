// THE-391 — adaptive per-query RRF weighting. Proves: (1) the lexical-specificity signal (rare
// term high, common term low, tokenizer-aligned via porter stemming, graceful null without
// signal), (2) the fusion tilt (a rare-term query lifts the lexical stream above a dense seed),
// and (3) strict neutrality (disabled / gain 0 / no signal reproduce static RRF exactly). FTS5-
// dependent tests self-skip when the runtime lacks FTS5, mirroring chunk-fts.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { querySpecificity } from "../src/search/adaptive_rrf";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { graphSearch } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

// Unit vector with cosine `c` to the query vec [1,0,0,0].
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

describe("THE-391 querySpecificity", () => {
  function specificityDb(): Database | null {
    const db = seedDb();
    // 5 docs share "banana"; only one contains "zebra"; one carries porter-stemmable "running".
    addChunk(db, "c1", "a.md", "banana zebra running", vd(0.9));
    addChunk(db, "c2", "b.md", "banana text", vd(0.8));
    addChunk(db, "c3", "c.md", "banana more text", vd(0.7));
    addChunk(db, "c4", "d.md", "banana filler", vd(0.6));
    addChunk(db, "c5", "e.md", "banana again", vd(0.5));
    if (!ensureChunkFts(db)) return null; // FTS5 not compiled into this runtime
    return db;
  }

  it("scores a corpus-rare term high and a ubiquitous term low", () => {
    const db = specificityDb();
    if (!db) return;
    const rare = querySpecificity(db, VAULT, "zebra");
    const common = querySpecificity(db, VAULT, "banana");
    expect(rare).not.toBeNull();
    expect(common).not.toBeNull();
    expect(rare as number).toBeGreaterThan(0.5);
    expect(common as number).toBeLessThan(0.2);
    expect(rare as number).toBeGreaterThan(common as number);
  });

  it("routes terms through the FTS tokenizer (porter): an inflected query form still matches", () => {
    const db = specificityDb();
    if (!db) return;
    // Corpus has "running"; the query says "runs" — porter stems both to "run".
    expect(querySpecificity(db, VAULT, "runs")).not.toBeNull();
  });

  it("returns null without a usable signal (absent terms, empty query, no FTS)", () => {
    const db = specificityDb();
    if (!db) return;
    expect(querySpecificity(db, VAULT, "frobnicatex")).toBeNull(); // not in corpus
    expect(querySpecificity(db, VAULT, " ... !!! ")).toBeNull(); // no terms
    const bare = seedDb(); // chunk_fts never provisioned
    expect(querySpecificity(bare, VAULT, "zebra")).toBeNull();
  });
});

describe("THE-391 adaptive fusion tilt", () => {
  // Fixture from chunk-fts.test.ts: a confident dense seed + fillers, plus a chunk only the
  // lexical stream can find (query terms present, near-zero cosine).
  function fusionDb(): Database | null {
    const db = seedDb();
    addChunk(db, "seed", "S.md", "unrelated seed text", vd(0.99));
    for (const [i, id] of ["n0", "n1", "n2"].entries()) {
      addChunk(db, id, `${id}.md`, "filler noise", vd(0.9 - i * 0.1));
    }
    addChunk(db, "lex", "L.md", "obsidian retrieval keyword zebra", vd(0.0));
    if (!ensureChunkFts(db)) return null;
    return db;
  }
  const OPTS = {
    query: "zebra keyword",
    queryVec: [1, 0, 0, 0],
    vaultId: VAULT,
    seedCount: 2,
    finalTopK: 10,
    router: { enabled: false as const },
  };

  it("a rare-term query lifts the lexical hit above the dense seed; static RRF does not", async () => {
    const db = fusionDb();
    if (!db) return;
    const staticIds = (await graphSearch(db, OPTS)).map((r) => r.chunk_id);
    const adaptiveIds = (await graphSearch(db, { ...OPTS, adaptiveRrf: { enabled: true } })).map(
      (r) => r.chunk_id,
    );
    // Static: seed and lex tie on 1/(k+0); the source tiebreak keeps the seed first.
    expect(staticIds[0]).toBe("seed");
    // Adaptive: both query terms are corpus-rare -> lexical stream upweighted past the seed.
    expect(adaptiveIds[0]).toBe("lex");
    expect(adaptiveIds.indexOf("lex")).toBeLessThan(staticIds.indexOf("lex"));
  });

  it("gain 0 and disabled reproduce static RRF exactly", async () => {
    const db = fusionDb();
    if (!db) return;
    const staticIds = (await graphSearch(db, OPTS)).map((r) => r.chunk_id);
    const gain0 = (await graphSearch(db, { ...OPTS, adaptiveRrf: { enabled: true, gain: 0 } })).map(
      (r) => r.chunk_id,
    );
    const disabled = (await graphSearch(db, { ...OPTS, adaptiveRrf: { enabled: false } })).map(
      (r) => r.chunk_id,
    );
    expect(gain0).toEqual(staticIds);
    expect(disabled).toEqual(staticIds);
  });

  it("no lexical signal (all query terms absent) stays neutral", async () => {
    const db = fusionDb();
    if (!db) return;
    const q = { ...OPTS, query: "frobnicatex qwertzuiop" };
    const staticIds = (await graphSearch(db, q)).map((r) => r.chunk_id);
    const adaptiveIds = (await graphSearch(db, { ...q, adaptiveRrf: { enabled: true } })).map(
      (r) => r.chunk_id,
    );
    expect(adaptiveIds).toEqual(staticIds);
  });

  it("the tilt never reorders seeds vs expansion — both carry the semantic-side weight", async () => {
    // Multi-hop targets ride the expansion stream: if the tilt down-weighted only the seed
    // stream, a rare-term query would jump expansion hits over seeds (and vice versa on
    // conceptual queries), distorting the graph ranking instead of the lexical-vs-semantic mix.
    const db = seedDb();
    addChunk(db, "seed", "S.md", "unrelated seed text", vd(0.99));
    addChunk(db, "exp", "E.md", "linked note body", vd(0.5)); // reachable only via the edge
    addChunk(db, "lex", "Z.md", "zebra keyword doc", vd(0.0)); // lexical-only
    db.prepare(
      "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', 'wikilink', 0, 0)",
    ).run(VAULT, "S.md", "E.md");
    if (!ensureChunkFts(db)) return;
    const opts = {
      query: "zebra", // corpus-rare -> semantic side down-weighted under adaptive
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 1, // seeds = {seed}; exp enters through expansion only
      finalTopK: 10,
      router: { enabled: false as const },
    };
    const staticIds = (await graphSearch(db, opts)).map((r) => r.chunk_id);
    const adaptiveIds = (await graphSearch(db, { ...opts, adaptiveRrf: { enabled: true } })).map(
      (r) => r.chunk_id,
    );
    expect(staticIds).toContain("exp");
    expect(adaptiveIds).toContain("exp");
    // Relative seed-vs-expansion order is identical with and without the tilt.
    expect(staticIds.indexOf("seed") < staticIds.indexOf("exp")).toBe(
      adaptiveIds.indexOf("seed") < adaptiveIds.indexOf("exp"),
    );
  });
});
