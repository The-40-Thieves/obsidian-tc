// THE-591 — proves retrieval.gatedRerank is actually REACHABLE end to end: a config value
// threaded through M7Deps.retrieval (registerM7Tools -> vault_graph_search) reaches
// graph_search_stages/rerank_stage.ts's THE-394 hard-query gate and OBSERVABLY calls the injected
// reranker — not merely that the option was passed. The gate and its unit tests
// (test/gated-rerank.test.ts) existed and were fully wired end-to-end from graphSearch's own
// options object, but until this ticket there was no config key: `rg gatedRerank` across src AND
// config.schema.ts found nothing, so the ONLY way to flip it on was the eval harness's
// `--gated-rerank` flag. This test asserts the flag now reaches the reranker call from the tool
// dispatch layer, using the same reranker-call-count spy test/gated-rerank.test.ts uses (asserting
// on the config value alone would prove nothing — that would pass even if buildGraphSearchOptions
// silently dropped it, which is exactly the bug this ticket closes).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { ToolRegistry } from "../src/mcp/registry";
import type { Reranker } from "../src/search/rerank";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const VAULT = "main";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

// Unit vector with cosine `c` to the query vec [1,0,0,0] — same fixture convention as
// test/gated-rerank.test.ts's hardDb().
function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function addChunk(db: Database, id: string, path: string, content: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

/** Every seed sits below the THE-394 default hardTop1 gate (0.55) -> a hard query, so
 *  gatedRerank:true (however it got wired) always fires when a reranker is present. */
function hardDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  addChunk(db, "a", "A.md", "alpha content", vd(0.4));
  addChunk(db, "b", "B.md", "beta content", vd(0.35));
  addChunk(db, "c", "C.md", "gamma content", vd(0.3));
  return db;
}

/** Same reverse-and-score spy as test/gated-rerank.test.ts. */
function spyReranker(): { reranker: Reranker; calls: Array<{ query: string; docs: string[] }> } {
  const calls: Array<{ query: string; docs: string[] }> = [];
  const reranker: Reranker = async (query, documents) => {
    calls.push({ query, docs: documents });
    return documents.map((_, i) => ({
      index: documents.length - 1 - i,
      relevanceScore: 1 - i * 0.1,
    }));
  };
  return { reranker, calls };
}

const root = mkdtempSync(join(tmpdir(), "obtc-gated-rerank-wiring-"));
afterAll(() => rmTemp(root));

function harness(retrieval: { gatedRerank?: boolean } | undefined, reranker: Reranker | null) {
  const db = hardDb();
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
    reranker,
    roles: null,
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

/** Dispatches vault_graph_search against a fresh spy reranker each call, returning the ordered
 *  chunk ids plus the spy's call log — the observable proof that config reached the consumer. */
async function search(
  retrieval: { gatedRerank?: boolean } | undefined,
): Promise<{ ids: string[]; calls: Array<{ query: string; docs: string[] }> }> {
  const { reranker, calls } = spyReranker();
  const h = harness(retrieval, reranker);
  const res = un<SearchData>(
    await h.registry.dispatch("vault_graph_search", { vault: VAULT, query: "anything" }, h.ctx),
  );
  return { ids: res.results.map((r) => r.chunk_id), calls };
}

describe("THE-591 — retrieval.gatedRerank config wiring (vault_graph_search)", () => {
  it("gatedRerank unset/false: reranker present but never called, pure RRF order", async () => {
    const withoutFlag = await search(undefined);
    expect(withoutFlag.calls).toHaveLength(0);
    expect(withoutFlag.ids).toEqual(["a", "b", "c"]);
    const explicitFalse = await search({ gatedRerank: false });
    expect(explicitFalse.calls).toHaveLength(0);
    expect(explicitFalse.ids).toEqual(["a", "b", "c"]);
  });

  it("gatedRerank:true on a hard query calls the reranker and reorders the results", async () => {
    const wired = await search({ gatedRerank: true });
    expect(wired.calls).toHaveLength(1);
    // Spy reverses the reranked head — proves the CONFIG flag, not just the unit-level option,
    // drove the actual reordering.
    expect(wired.ids).toEqual(["c", "b", "a"]);
  });

  it("gatedRerank:true with no reranker configured degrades to pure RRF (no throw)", async () => {
    const h = harness({ gatedRerank: true }, null);
    const res = un<SearchData>(
      await h.registry.dispatch("vault_graph_search", { vault: VAULT, query: "anything" }, h.ctx),
    );
    expect(res.results.map((r) => r.chunk_id)).toEqual(["a", "b", "c"]);
  });
});
