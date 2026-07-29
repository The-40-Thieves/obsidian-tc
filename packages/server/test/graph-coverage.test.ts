// THE-631: an honest, additive coverage estimate for a graphSearch() call — reported via
// opts.onCoverage, never fed back into scoring or ordering (see graph_search.ts's
// estimateCoverage() doc comment for exactly what each field means). This file pins the value
// for known fixtures: a single-arm/seeds-only case (low coverage), a seed+expansion case (higher
// coverage), an expansion-capped case, and an under-filled page — plus a same-ranking check
// proving the callback is a pure side-channel.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { type CoverageEstimate, graphSearch } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function vecDim01(cos: number): number[] {
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

function addEdge(db: Database, source: string, target: string): void {
  db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', 'wikilink_forward', 0, 0)",
  ).run(VAULT, source, target);
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
  return db;
}

async function coverageOf(
  db: Database,
  opts: Parameters<typeof graphSearch>[1],
): Promise<CoverageEstimate | undefined> {
  let coverage: CoverageEstimate | undefined;
  await graphSearch(db, { ...opts, onCoverage: (c) => (coverage = c) });
  return coverage;
}

describe("THE-631: graphSearch coverage estimate", () => {
  it("low coverage: an isolated seed hit with no linked note reports one arm, expansion skipped", async () => {
    const db = db0();
    addChunk(db, "cD", "D.md", vecDim01(0.99)); // dominant, isolated seed
    const noise = [0.1, 0.08, 0.06, 0.04];
    noise.forEach((c, i) => {
      addChunk(db, `cN${i}`, `N${i}.md`, vecDim01(c));
    });
    const coverage = await coverageOf(db, {
      query: "direct",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      finalTopK: 10,
    });
    expect(coverage).toEqual({
      arms: ["seed"],
      armsContributed: 1,
      armsPossible: 5,
      expansionSkipped: true, // router: top1 dominance routes to seeds-only
      expansionTruncated: false, // expansion never ran
      requested: 10,
      returned: 5,
      underfilled: true, // only 5 candidates exist in this corpus; the page asked for 10
    } satisfies CoverageEstimate);
  });

  it("higher coverage: a linked bridge note adds the expansion arm", async () => {
    const db = db0();
    addChunk(db, "cA", "A.md", vecDim01(0.95)); // top seed
    addChunk(db, "cB", "B.md", vecDim01(0.25)); // bridge: outside vector top-k, linked from A
    addEdge(db, "A.md", "B.md");
    const coverage = await coverageOf(db, {
      query: "bridge",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 1, // B's cosine (0.25) must lose the seed cut to be reachable via expansion only
      finalTopK: 10,
      router: { enabled: false }, // exercise expansion regardless of seed strength
    });
    expect(coverage?.arms.sort()).toEqual(["expansion", "seed"]);
    expect(coverage?.armsContributed).toBe(2);
    expect(coverage?.expansionSkipped).toBe(false);
    expect(coverage?.expansionTruncated).toBe(false); // one candidate, cap never binds
  });

  it("expansion capped: maxExpansionChunks discards qualifying candidates", async () => {
    const db = db0();
    addChunk(db, "cA", "A.md", vecDim01(0.95));
    for (let i = 0; i < 5; i++) {
      addChunk(db, `cB${i}`, `B${i}.md`, vecDim01(0.3));
      addEdge(db, "A.md", `B${i}.md`);
    }
    const coverage = await coverageOf(db, {
      query: "bridge",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 1, // the B* chunks must lose the seed cut to be reachable via expansion only
      finalTopK: 10,
      router: { enabled: false },
      maxExpansionChunks: 2, // 5 candidates qualify, only 2 fit
    });
    expect(coverage?.expansionTruncated).toBe(true);
    expect(coverage?.arms).toContain("expansion");
  });

  it("under-filled page: fewer candidates exist than the caller asked for", async () => {
    const db = db0();
    addChunk(db, "cA", "A.md", vecDim01(0.9));
    addChunk(db, "cB", "B.md", vecDim01(0.85));
    const coverage = await coverageOf(db, {
      query: "small corpus",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      finalTopK: 25,
    });
    expect(coverage?.requested).toBe(25);
    expect(coverage?.returned).toBeLessThan(25);
    expect(coverage?.underfilled).toBe(true);
  });

  it("is a pure side-channel: attaching onCoverage never changes the returned ranking", async () => {
    const db = db0();
    addChunk(db, "cA", "A.md", vecDim01(0.95));
    addChunk(db, "cB", "B.md", vecDim01(0.25));
    addEdge(db, "A.md", "B.md");
    const opts: Parameters<typeof graphSearch>[1] = {
      query: "bridge",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 10,
      finalTopK: 10,
      router: { enabled: false },
    };
    const without = await graphSearch(db, opts);
    const withCallback = await graphSearch(db, { ...opts, onCoverage: () => {} });
    expect(withCallback).toEqual(without);
  });
});
