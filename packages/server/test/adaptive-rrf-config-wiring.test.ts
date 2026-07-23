// THE-536 — thread config.retrieval.adaptiveRrf through M7Deps.retrieval and vault_graph_search
// (and the other three graphSearch call sites) so the THE-391 lever, until now only reachable from
// the eval harness (--adaptive-rrf), can actually fire in production. Proves the whole safety
// claim: unset/false is a byte-identical no-op on the ordered chunk_id list, and enabled:true on a
// rare-term query reorders the results identically to calling graphSearch directly with the same
// adaptiveRrf option.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { graphSearch } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const VAULT = "main";

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

// Unit vector with cosine `c` to the query vec [1,0,0,0] — same fixture convention as
// adaptive-rrf.test.ts.
function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function addChunk(
  db: ReturnType<typeof openMemoryDb>,
  id: string,
  path: string,
  content: string,
  vec?: number[],
): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0);
  if (vec) {
    db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
    ).run(id, "test:embed", vec.length, floatBlob(vec));
  }
}

/** Fixture mirroring adaptive-rrf.test.ts's fusionDb: a confident dense seed plus a chunk only the
 *  lexical stream can find (rare query terms present, NO embedding at all — vault_graph_search
 *  runs with the tool's default seedCount, so unlike the direct-graphSearch unit test this fixture
 *  keeps the lexical-only chunk out of vector-seed generation by construction, not by truncation).
 *  Returns null when the runtime lacks FTS5 (mirrors chunk-fts.test.ts's self-skip convention). */
function fusionDb() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  addChunk(db, "seed", "S.md", "unrelated seed text", vd(0.99));
  for (const [i, id] of ["n0", "n1", "n2"].entries()) {
    addChunk(db, id, `${id}.md`, "filler noise", vd(0.9 - i * 0.1));
  }
  addChunk(db, "lex", "L.md", "obsidian retrieval keyword zebra"); // no embedding — lexical-only
  if (!ensureChunkFts(db)) return null;
  return db;
}

const root = mkdtempSync(join(tmpdir(), "obtc-adaptive-rrf-wiring-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function harness(retrieval?: { adaptiveRrf?: { enabled?: boolean; gain?: number } }) {
  const db = fusionDb();
  if (!db) return null;
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]);
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: {
      id: "test:embed",
      provider: "ollama",
      model: "stub",
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
    } as any,
    reranker: null,
    roles: null,
    // classRouter left unset -> vault_graph_search always takes the standard (embed) path.
    ...(retrieval ? { retrieval } : {}),
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:notes"]),
    vaultId: VAULT,
    db,
  };
  return { registry, ctx, db };
}

interface SearchData {
  vault: string;
  results: Array<{ chunk_id: string }>;
}

async function search(retrieval?: { adaptiveRrf?: { enabled?: boolean; gain?: number } }) {
  const h = harness(retrieval);
  if (!h) return null;
  const res = un<SearchData>(
    await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT, query: "zebra keyword" },
      h.ctx,
    ),
  );
  return res.results.map((r) => r.chunk_id);
}

describe("THE-536 — retrieval.adaptiveRrf config wiring (vault_graph_search)", () => {
  it("byte-identical to today when retrieval is unset", async () => {
    const withoutDeps = await search(undefined);
    if (!withoutDeps) return; // no FTS5 in this runtime
    const explicitDisabled = await search({ adaptiveRrf: { enabled: false } });
    const explicitUnset = await search({});
    expect(explicitDisabled).toEqual(withoutDeps);
    expect(explicitUnset).toEqual(withoutDeps);
  });

  it("enabled:true reorders a rare-term query and matches graphSearch called directly", async () => {
    const baseline = await search(undefined);
    if (!baseline) return; // no FTS5 in this runtime
    const wired = await search({ adaptiveRrf: { enabled: true } });
    expect(wired).not.toEqual(baseline);
    // Independently confirm the tool's wired order matches graphSearch called directly with the
    // same option — the tool is a thin pass-through, not a second implementation.
    const h = harness();
    if (!h) return;
    const direct = (
      await graphSearch(h.db, {
        query: "zebra keyword",
        queryVec: [1, 0, 0, 0],
        model: "test:embed",
        vaultId: VAULT,
        finalTopK: 30,
        adaptiveRrf: { enabled: true },
        isReadable: () => true,
      })
    ).map((r) => r.chunk_id);
    expect(wired).toEqual(direct);
  });
});
