// THE-73 Phase 3 — Ebbinghaus recency decay on the expansion stream. A stale bridge has HIGHER raw
// cosine than a recent one, so without decay the stale one ranks first. Enabling decay with an
// injected clock weights the stale bridge down (exp(-lambda * days)) so the recent bridge overtakes
// it, without dropping either below the raw-cosine similarity gate.
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
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function db0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  db.exec(
    `CREATE TABLE notes (vault_id TEXT NOT NULL, path TEXT NOT NULL, mtime INTEGER NOT NULL);`,
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

function addEdge(db: Database, source: string, target: string): void {
  db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', 'wikilink', 0, 0)",
  ).run(VAULT, source, target);
}

function addNote(db: Database, path: string, mtime: number): void {
  db.prepare("INSERT INTO notes (vault_id, path, mtime) VALUES (?, ?, ?)").run(VAULT, path, mtime);
}

describe("Ebbinghaus decay on expansion (THE-73 Phase 3)", () => {
  it("recency overtakes a higher-cosine stale bridge when decay is on", async () => {
    const db = db0();
    addChunk(db, "cA", "A.md", vd(0.95)); // seed
    addChunk(db, "cC", "C.md", vd(0.5)); // stale bridge, HIGHER raw cosine
    addChunk(db, "cB", "B.md", vd(0.3)); // recent bridge, lower raw cosine
    addEdge(db, "A.md", "C.md");
    addEdge(db, "A.md", "B.md");
    addNote(db, "C.md", NOW - 400 * DAY);
    addNote(db, "B.md", NOW);

    const common = {
      query: "q",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 1, // only cA seeds; cB/cC are reached via expansion, where decay applies
      finalTopK: 10,
      router: { enabled: false },
      lexical: { enabled: false },
    };
    const off = await graphSearch(db, common);
    const on = await graphSearch(db, {
      ...common,
      decay: { enabled: true, lambda: 0.01, nowMs: NOW },
    });
    const pos = (res: GraphSearchResult[], id: string): number =>
      res.findIndex((r) => r.chunk_id === id);

    // Without decay, cosine wins: the higher-cosine stale C outranks recent B.
    expect(pos(off, "cC")).toBeLessThan(pos(off, "cB"));
    // With decay, recency overtakes cosine: recent B before stale C, and both survive the raw gate.
    expect(pos(on, "cB")).toBeGreaterThanOrEqual(0);
    expect(pos(on, "cC")).toBeGreaterThanOrEqual(0);
    expect(pos(on, "cB")).toBeLessThan(pos(on, "cC"));
    expect(on.length).toBe(off.length);
  });
});
