// THE-444 — knowledge_search: the docs-corpus retrieval tool. Proves the read:docs isolation
// gate (denied without it) and that it returns corpus results via the lexical route (no embed
// backend needed), reusing the same harness as reflect-tool.test.ts (provisionCacheDb + FTS +
// classRouter with a throwing embed stub). Retrieval correctness itself is covered by the
// graph-*.test.ts suite; this pins the new tool's scope + wiring.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const NOW = 1_700_000_000_000;
const VAULT = "vendor-docs";

function docsDb() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', ?, ?, 40, ?, ?)",
  ).run(
    "d1",
    VAULT,
    "context7/resolve.md",
    "the quorble gotcha for resolve-library-id",
    "h1",
    NOW,
    NOW,
  );
  ensureChunkFts(db, { now: () => NOW, enrich: false });
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

const root = mkdtempSync(join(tmpdir(), "obtc-kdocs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function harness(scopes: string[], kind: "private" | "docs" | "system" = "docs") {
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root, kind }]);
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: {
      provider: "ollama",
      model: "stub",
      embed: async () => {
        throw new Error("embed must not be called on the lexical route");
      },
    } as any,
    reranker: null,
    roles: null,
    classRouter: true,
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(scopes),
    vaultId: VAULT,
    db: docsDb(),
    now: () => NOW,
  };
  return { registry, ctx };
}

describe("knowledge_search (docs corpus, read:docs isolation)", () => {
  it("is denied without read:docs (isolated from the private-vault read scope)", async () => {
    const { registry, ctx } = harness(["read:notes"]);
    const r = (await registry.dispatch(
      "knowledge_search",
      { vault: VAULT, query: "quorble" },
      ctx,
    )) as { ok: boolean };
    expect(r.ok).toBe(false);
  });

  it("P1.5: refuses a non-docs (private) vault even under read:docs", async () => {
    const { registry, ctx } = harness(["read:docs"], "private");
    const r = (await registry.dispatch(
      "knowledge_search",
      { vault: VAULT, query: "quorble" },
      ctx,
    )) as { ok: boolean; error?: { code: string } };
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.code).toBe("forbidden");
  });

  it("returns corpus results under read:docs (lexical route, no embed)", async () => {
    const { registry, ctx } = harness(["read:docs"]);
    const res = un<{
      vault: string;
      mode_used: string;
      results: Array<{ chunk_id: string }>;
    }>(await registry.dispatch("knowledge_search", { vault: VAULT, query: "quorble" }, ctx));
    expect(res.vault).toBe(VAULT);
    expect(res.mode_used).toBe("lexical-route");
    expect(res.results.map((x) => x.chunk_id)).toContain("d1");
  });
});
