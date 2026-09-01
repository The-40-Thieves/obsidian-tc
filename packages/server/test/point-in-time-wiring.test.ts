// THE-635 — wiring the previously-DEAD point_in_time.ts module (filterChunksAsOf/changedSinceD:
// fully unit-tested in point_in_time.test.ts, but with ZERO production callers) into the live
// knowledge_search/vault_graph_search retrieval path via an explicit `as_of` (+ optional `since`)
// argument. point_in_time.test.ts already proves the pure filter/flag logic in isolation; THIS
// file proves the WIRING end to end through a real tool dispatch:
//   - `as_of` PRE-filters the candidate set (candidateAssembly, before fusion/ranking) rather than
//     dropping already-ranked results, and stamps `changed_since_d` on every survivor;
//   - omitting `as_of` is byte-identical to before this ticket (a chunk created after "D" still
//     comes back, and no result carries a `changed_since_d` key at all);
//   - the filter composes WITH ACL rather than instead of it;
//   - `since > as_of` is a clean invalidInput, before any DB/embedding work.
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const VAULT = "v1";
const QUERY_VEC = [1, 0, 0, 0];
const D = 200; // the point-in-time boundary under test

function fixedVectorProvider(vec: number[]): EmbeddingProvider {
  return {
    id: "test:fixed",
    provider: "fake",
    model: "fixed",
    dimensions: vec.length,
    embed: async (texts: string[]) => texts.map(() => vec),
  };
}

function addChunk(
  db: Database,
  id: string,
  path: string,
  createdAt: number,
  updatedAt: number,
): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `body ${id}`, `hash-${id}`, 1, createdAt, updatedAt);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:fixed", QUERY_VEC.length, floatBlob(QUERY_VEC));
}

/** before: existed at D=200, never touched since -> changedSinceD false.
 *  edited: existed at D (created 50 <= 200) but touched after (250 > 200) -> changedSinceD true.
 *  after:  created 300, entirely after D -> excluded outright, no flag. */
function buildFixture(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  addChunk(db, "before", "public/before.md", 50, 100);
  addChunk(db, "edited", "public/edited.md", 50, 250);
  addChunk(db, "after", "public/after.md", 300, 300);
  return db;
}

function harness(db: Database, acl?: FolderAcl): { registry: ToolRegistry; ctx: CallerContext } {
  const vaultRegistry = new VaultRegistry([
    { id: VAULT, path: "/nonexistent/does-not-need-to-exist" },
  ]);
  const registry = new ToolRegistry({ aclResolver: () => acl });
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: fixedVectorProvider(QUERY_VEC),
    reranker: null,
    roles: null,
    acl,
  });
  const ctx: CallerContext = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:notes"]),
    vaultId: VAULT,
    db,
    acl,
  };
  return { registry, ctx };
}

type Result = { path: string; chunk_id: string; changed_since_d?: boolean };

async function search(
  registry: ToolRegistry,
  ctx: CallerContext,
  extra: Record<string, unknown> = {},
): Promise<Result[]> {
  const res = await registry.dispatch(
    "vault_graph_search",
    { vault: VAULT, query: "q", final_top_k: 50, ...extra },
    ctx,
  );
  expect(res.ok).toBe(true);
  if (!res.ok) return [];
  return (res.data as { results: Result[] }).results;
}

describe("THE-635 wiring — vault_graph_search as_of", () => {
  it("PRE-filters the candidate set: excludes a chunk created after D, keeps + flags the rest", async () => {
    const { registry, ctx } = harness(buildFixture());
    const results = await search(registry, ctx, { as_of: D });
    const byId = new Map(results.map((r) => [r.chunk_id, r]));
    // The mutation this proves load-bearing: removing candidate_assembly.ts's THE-635 pre-filter
    // block (or its `opts.asOf !== undefined` guard) makes "after" a normal seed hit again — this
    // assertion reds the instant that happens.
    expect(byId.has("after")).toBe(false);
    expect(byId.get("before")?.changed_since_d).toBe(false);
    expect(byId.get("edited")?.changed_since_d).toBe(true);
  });

  it("as_of absent is byte-identical to before THE-635: the post-D chunk returns, no changed_since_d key anywhere", async () => {
    const { registry, ctx } = harness(buildFixture());
    const results = await search(registry, ctx);
    const byId = new Map(results.map((r) => [r.chunk_id, r]));
    expect(byId.has("after")).toBe(true);
    expect(byId.has("before")).toBe(true);
    expect(byId.has("edited")).toBe(true);
    for (const r of results) expect(Object.hasOwn(r, "changed_since_d")).toBe(false);
  });

  it("since > as_of is rejected via invalidInput, before any DB/embedding work", async () => {
    const { registry, ctx } = harness(buildFixture());
    const res = await registry.dispatch(
      "vault_graph_search",
      { vault: VAULT, query: "q", as_of: 100, since: 200 },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error?.code).toBe("invalid_input");
  });

  it("since without as_of is rejected via invalidInput", async () => {
    const { registry, ctx } = harness(buildFixture());
    const res = await registry.dispatch(
      "vault_graph_search",
      { vault: VAULT, query: "q", since: 0 },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error?.code).toBe("invalid_input");
  });

  it("composes WITH ACL, never instead of it: a chunk that existed at D but is ACL-denied is never returned", async () => {
    const db = buildFixture();
    addChunk(db, "secret", "secret/denied.md", 50, 100); // existed at D, unchanged — but ACL-denied
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: ["read:notes"],
      rules: [],
      readPaths: ["public/**"], // denies secret/**
    } as AclConfigT);
    const { registry, ctx } = harness(db, acl);
    const results = await search(registry, ctx, { as_of: D });
    expect(results.some((r) => r.path === "secret/denied.md")).toBe(false);
    // Non-vacuous: the readable chunks that existed at D still come back, correctly flagged.
    expect(results.some((r) => r.path === "public/before.md")).toBe(true);
    expect(results.some((r) => r.path === "public/edited.md")).toBe(true);
  });
});

describe("THE-635 wiring — knowledge_search as_of (docs corpus)", () => {
  function docsHarness(db: Database): { registry: ToolRegistry; ctx: CallerContext } {
    const vaultRegistry = new VaultRegistry([
      { id: VAULT, name: VAULT, path: "/nonexistent/does-not-need-to-exist", kind: "docs" },
    ]);
    const registry = new ToolRegistry({});
    registerM7Tools(registry, {
      vaultRegistry,
      embeddingProvider: fixedVectorProvider(QUERY_VEC),
      reranker: null,
      roles: null,
    });
    const ctx: CallerContext = {
      caller: "tester",
      authenticated: true,
      grantedScopes: new Set(["read:docs"]),
      vaultId: VAULT,
      db,
    };
    return { registry, ctx };
  }

  it("PRE-filters and flags the same way as vault_graph_search", async () => {
    const { registry, ctx } = docsHarness(buildFixture());
    const res = await registry.dispatch(
      "knowledge_search",
      { vault: VAULT, query: "q", final_top_k: 50, as_of: D },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const results = (res.data as { results: Result[] }).results;
    const byId = new Map(results.map((r) => [r.chunk_id, r]));
    expect(byId.has("after")).toBe(false);
    expect(byId.get("before")?.changed_since_d).toBe(false);
    expect(byId.get("edited")?.changed_since_d).toBe(true);
  });

  it("as_of absent is byte-identical: the post-D chunk returns, untagged", async () => {
    const { registry, ctx } = docsHarness(buildFixture());
    const res = await registry.dispatch(
      "knowledge_search",
      { vault: VAULT, query: "q", final_top_k: 50 },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const results = (res.data as { results: Result[] }).results;
    expect(results.some((r) => r.chunk_id === "after")).toBe(true);
    for (const r of results) expect(Object.hasOwn(r, "changed_since_d")).toBe(false);
  });
});
