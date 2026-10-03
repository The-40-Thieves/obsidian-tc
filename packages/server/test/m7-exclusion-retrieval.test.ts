import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmTemp(root);
});

function rootWithExclusion(entry: string): string {
  const root = makeTempDir("obtc-m7-exclusion-");
  roots.push(root);
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian/app.json"), JSON.stringify({ userIgnoreFilters: [entry] }));
  return root;
}

function addChunk(db: Database, vaultId: string, id: string, path: string, content: string): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, '0', '[]', ?, ?, 10, 0, 0)",
  ).run(id, vaultId, path, content, `hash-${id}`);
}

function harness(vaults: Array<{ id: string; path: string; kind?: "private" | "docs" }>) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry({});
  registerM7Tools(registry, {
    vaultRegistry: new VaultRegistry(vaults),
    embeddingProvider: {
      id: "test:fixed",
      provider: "fake",
      model: "fixed",
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
    },
    reranker: null,
    roles: null,
    classRouter: true,
  });
  const ctx = (vaultId: string): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:notes", "read:docs"]),
    vaultId,
    db,
  });
  return { db, registry, ctx };
}

function dataOf<T>(result: Awaited<ReturnType<ToolRegistry["dispatch"]>>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.data as T;
}

describe("M7 retrieval honors live vault exclusions", () => {
  it("does not return an excluded rare-token note from vault_context, reflect, or knowledge_search", async () => {
    const privateRoot = rootWithExclusion("secret/");
    const docsRoot = rootWithExclusion("secret/");
    const h = harness([
      { id: "main", path: privateRoot },
      { id: "docs", path: docsRoot, kind: "docs" },
    ]);
    addChunk(h.db, "main", "private-secret", "secret/private.md", "zygomorphicprivate");
    addChunk(h.db, "docs", "docs-secret", "secret/docs.md", "zygomorphicdocs");
    ensureChunkFts(h.db, { enrich: false });

    const context = dataOf<{ notes: Array<{ path: string }>; lessons: Array<{ path: string }> }>(
      await h.registry.dispatch(
        "vault_context",
        { vault: "main", query: "zygomorphicprivate", include_lessons: false },
        h.ctx("main"),
      ),
    );
    expect.soft(JSON.stringify(context)).not.toContain("secret/private.md");

    const reflect = dataOf<{ sources: Array<{ path: string }> }>(
      await h.registry.dispatch(
        "reflect",
        { vault: "main", query: "zygomorphicprivate", mode: "synthesis" },
        h.ctx("main"),
      ),
    );
    expect.soft(reflect.sources.map((source) => source.path)).not.toContain("secret/private.md");

    const knowledge = dataOf<{ results: Array<{ path: string }> }>(
      await h.registry.dispatch(
        "knowledge_search",
        { vault: "docs", query: "zygomorphicdocs" },
        h.ctx("docs"),
      ),
    );
    expect.soft(knowledge.results.map((result) => result.path)).not.toContain("secret/docs.md");
  });

  it("does not add an excluded lessons note through vault_context's default-on lessons lookup", async () => {
    const root = rootWithExclusion("lessons/");
    const h = harness([{ id: "main", path: root }]);
    addChunk(h.db, "main", "visible", "notes/visible.md", "pedagogicalneedle pedagogicalneedle");
    addChunk(h.db, "main", "hidden-lesson", "lessons/hidden.md", "pedagogicalneedle");
    ensureChunkFts(h.db, { enrich: false });

    const context = dataOf<{ notes: Array<{ path: string }>; lessons: Array<{ path: string }> }>(
      await h.registry.dispatch(
        "vault_context",
        { vault: "main", query: "pedagogicalneedle", k: 1 },
        h.ctx("main"),
      ),
    );
    expect(context.lessons.map((lesson) => lesson.path)).not.toContain("lessons/hidden.md");
    expect(JSON.stringify(context.notes)).not.toContain("lessons/hidden.md");
  });
});
