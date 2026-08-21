// THE-852 — wiring THE-695's dark `ensureAclPathSet` mechanism into the real M7 call sites and
// defaulting it on. graph-walk-acl.test.ts already proves the CTE join itself is correct
// (THE-695) and adds the full-field two-world differential for it (THE-852). This file proves the
// WIRING: that a real `vault_graph_search` dispatch — going through `buildGraphSearchOptions` /
// `resolveAclWalkFilter`, not a hand-built GraphSearchOptions object — actually applies the filter
// by default, and that a restricted caller fails CLOSED rather than falling back to the unfiltered
// walk when the permitted-path set cannot be resolved.
//
// Fixture shape throughout: public/a.md --links_to--> secret/s.md --links_to--> public/b.md, plus
// enough decoy notes to push b.md out of the dense arm's top-K seed window (so its presence in a
// restricted caller's results depends ENTIRELY on the graph walk reaching it through the bridge —
// exactly the THE-852 Defect 2 shape). Every chunk's cosine to the query is far below the
// seed-strength router's routerSim (0.62 default), so classify() never routes to seeds-only and
// expansion always runs — the property under test.
import { describe, expect, it, vi } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { ensureAclPathSet } from "../src/search/acl_path_set";
import { expandGraph } from "../src/search/graph_search_stages/graph_expansion";
import type { GraphSearchOptions } from "../src/search/graph_search_stages/types";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import { resolveAclWalkFilter } from "../src/tools/m7/knowledge/retrieval-runtime";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const VAULT = "v1";
const GRANTED = new Set(["read:notes"]);
const QUERY_VEC = [1, 0, 0, 0];
const DECOY_COUNT = 30; // >= the M7 default seedCount (30), so b.md never cracks the dense window.

/** Every chunk is embedded to a fixed, hand-picked cosine against QUERY_VEC — never computed from
 *  text — so seed ranking is exactly controlled. a.md/decoys sit well under the router's
 *  routerSim=0.62 so classify() never routes to seeds-only and the graph-expansion stage always
 *  runs (the code path THE-852 wires into). */
function vd(cosine: number): number[] {
  return [cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine)), 0, 0];
}

function fixedVectorProvider(vec: number[]): EmbeddingProvider {
  return {
    id: "test:fixed",
    provider: "fake",
    model: "fixed",
    dimensions: vec.length,
    embed: async (texts: string[]) => texts.map(() => vec),
  };
}

function addChunk(db: Database, id: string, path: string, cosine: number): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `body ${id}`, `hash-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:fixed", 4, floatBlob(vd(cosine)));
}

function addEdge(db: Database, source: string, target: string): void {
  db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', 'wikilink', 0, 0)",
  ).run(VAULT, source, target);
}

/** public/a.md -> secret/s.md -> public/b.md, plus DECOY_COUNT readable decoys ranked between
 *  a.md and b.md so b.md never enters the dense arm's top-K on its own. */
function buildFixture(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  addChunk(db, "a", "public/a.md", 0.55);
  addChunk(db, "s", "secret/s.md", 0.4); // ACL-denied; excluded from dense seeds regardless.
  addChunk(db, "b", "public/b.md", 0.3); // reachable only via the bridge, if unfiltered.
  for (let i = 0; i < DECOY_COUNT; i++) addChunk(db, `d${i}`, `public/decoy-${i}.md`, 0.5);
  addEdge(db, "public/a.md", "secret/s.md");
  addEdge(db, "secret/s.md", "public/b.md");
  return db;
}

const RESTRICTED_ACL: AclConfigT = {
  readOnly: false,
  defaultScopes: ["read:notes"],
  rules: [],
  readPaths: ["public/**"], // denies secret/**
};

interface Harness {
  db: Database;
  registry: ToolRegistry;
  ctx: (over?: Partial<CallerContext>) => CallerContext;
}

function harness(
  db: Database,
  acl: FolderAcl | undefined,
  onAclWalkPruned?: (vault: string, count: number) => void,
): Harness {
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
    // THE-891 item 3: optional, mirrors every other observability seam on M7Deps.
    ...(onAclWalkPruned ? { onAclWalkPruned } : {}),
  });
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: GRANTED,
    vaultId: VAULT,
    db,
    acl,
    ...over,
  });
  return { db, registry, ctx };
}

type SearchResult = { path: string; via_edge: { source_path: string } | null };

async function search(h: Harness, query = "q"): Promise<SearchResult[]> {
  const res = await h.registry.dispatch(
    "vault_graph_search",
    { vault: VAULT, query, final_top_k: 50 },
    h.ctx(),
  );
  expect(res.ok).toBe(true);
  if (!res.ok) return [];
  return (res.data as { results: SearchResult[] }).results;
}

describe("THE-852 wiring — resolveAclWalkFilter", () => {
  it("restricted caller + resolvable substrate -> filter enabled with a real aclSetId", () => {
    const db = buildFixture();
    const acl = new FolderAcl(RESTRICTED_ACL);
    const result = resolveAclWalkFilter(db, VAULT, acl, GRANTED, (p) => !p.startsWith("secret/"));
    expect(result.aclWalkFilter?.enabled).toBe(true);
    expect(result.aclWalkFilter?.blocked).toBeUndefined();
    expect(typeof result.aclSetId).toBe("number");
    // THE-891 item 3: `restricted` is the metrics-only gate graph_expansion.ts reads to decide
    // whether it may re-walk unfiltered for the prune count — set here because this caller
    // genuinely can lose recall to the filter.
    expect(result.aclWalkFilter?.restricted).toBe(true);
  });

  it("unrestricted caller + resolvable substrate -> filter enabled WITHOUT `restricted` (THE-891 item 3)", () => {
    const db = buildFixture();
    const result = resolveAclWalkFilter(db, VAULT, undefined, GRANTED, () => true);
    expect(result.aclWalkFilter?.enabled).toBe(true);
    expect(typeof result.aclSetId).toBe("number");
    // Unset, not false: an unrestricted caller's join is a proven structural no-op, so the
    // prune-count re-walk must never even be attempted for them.
    expect(result.aclWalkFilter?.restricted).toBeUndefined();
  });

  it("unrestricted caller + missing substrate -> no-op ({}), byte-identical to before this ticket", () => {
    const db = openMemoryDb(); // no migrations at all -> acl_path_sets absent
    const result = resolveAclWalkFilter(db, VAULT, undefined, GRANTED, () => true);
    expect(result).toEqual({});
  });

  it("restricted caller + missing substrate -> FAILS CLOSED (blocked:true, no aclSetId)", () => {
    const db = openMemoryDb(); // acl_path_sets absent -> ensureAclPathSet returns null
    const acl = new FolderAcl(RESTRICTED_ACL);
    const result = resolveAclWalkFilter(db, VAULT, acl, GRANTED, (p) => !p.startsWith("secret/"));
    expect(result.aclWalkFilter).toEqual({ enabled: true, blocked: true });
    expect(result.aclSetId).toBeUndefined();
  });

  it("absent isReadable -> no-op ({}), matching this codebase's existing 'no filter' convention", () => {
    const db = buildFixture();
    const result = resolveAclWalkFilter(
      db,
      VAULT,
      new FolderAcl(RESTRICTED_ACL),
      GRANTED,
      undefined,
    );
    expect(result).toEqual({});
  });

  it("empty readable set (restricted, everything denied) also fails closed, never silently unfiltered", () => {
    const db = buildFixture();
    const acl = new FolderAcl({ ...RESTRICTED_ACL, readPaths: ["nowhere/**"] });
    const result = resolveAclWalkFilter(db, VAULT, acl, GRANTED, () => false);
    // ensureAclPathSet's own empty-set floor returns null here (acl_path_set.ts), and the caller is
    // restricted, so this must still be the fail-closed branch, not a silent no-op.
    expect(result.aclWalkFilter).toEqual({ enabled: true, blocked: true });
  });
});

describe("THE-852 wiring — expandGraph honors `blocked`", () => {
  it("skips the walk entirely and warns, even though the bridge is structurally reachable", () => {
    const db = buildFixture();
    const isReadable = (p: string) => !p.startsWith("secret/");
    // Prove the bridge WOULD be reachable if unfiltered (non-vacuous guard, mirrors
    // graph-walk-acl.test.ts's own "documents the defect" test).
    const unfiltered = expandGraph({
      db,
      opts: { query: "q", queryVec: QUERY_VEC, vaultId: VAULT, isReadable } as GraphSearchOptions,
      seedPaths: ["public/a.md"],
      seedChunkIds: new Set(),
      hopLimit: 2,
      similarityThreshold: 0.2,
      maxExpansionChunks: 50,
      decayEnabled: false,
      decayLambda: 0,
      decayNowMs: 0,
    });
    expect(unfiltered.expansionChunks.some((c) => c.path === "public/b.md")).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocked = expandGraph({
      db,
      opts: {
        query: "q",
        queryVec: QUERY_VEC,
        vaultId: VAULT,
        isReadable,
        aclWalkFilter: { enabled: true, blocked: true },
      } as GraphSearchOptions,
      seedPaths: ["public/a.md"],
      seedChunkIds: new Set(),
      hopLimit: 2,
      similarityThreshold: 0.2,
      maxExpansionChunks: 50,
      decayEnabled: false,
      decayLambda: 0,
      decayNowMs: 0,
    });
    expect(blocked.expansionChunks).toEqual([]);
    expect(blocked.truncated).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("THE-852");
    warn.mockRestore();

    // Sanity: ensureAclPathSet itself was never called by this test — the block decision is made
    // upstream, by resolveAclWalkFilter — this test is purely about expandGraph honoring the flag.
    expect(typeof ensureAclPathSet).toBe("function");
  });
});

describe("THE-852 wiring — real vault_graph_search dispatch", () => {
  it("restricted caller: no ACL-denied path anywhere in the response payload (Defect 1)", async () => {
    const h = harness(buildFixture(), new FolderAcl(RESTRICTED_ACL));
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT, query: "q", final_top_k: 50 },
      h.ctx(),
    );
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain("secret/s.md");
  });

  it("restricted caller: no result's via_edge.source_path is ever a denied path (regression guard)", async () => {
    const h = harness(buildFixture(), new FolderAcl(RESTRICTED_ACL));
    const results = await search(h);
    for (const r of results) {
      if (r.via_edge) expect(r.via_edge.source_path.startsWith("secret/")).toBe(false);
    }
  });

  it("restricted caller: the bridge-only-reachable note is ABSENT (Defect 2, membership oracle closed)", async () => {
    const h = harness(buildFixture(), new FolderAcl(RESTRICTED_ACL));
    const results = await search(h);
    expect(results.some((r) => r.path === "public/b.md")).toBe(false);
    expect(results.some((r) => r.path === "secret/s.md")).toBe(false);
    // Non-vacuous: a.md and the decoys ARE returned, so this is genuine pruning, not a broken search.
    expect(results.some((r) => r.path === "public/a.md")).toBe(true);
  });

  it("unrestricted caller: the bridge-reached note IS present — the default-on fix is a no-op for them", async () => {
    const h = harness(buildFixture(), undefined);
    const results = await search(h);
    expect(results.some((r) => r.path === "public/b.md")).toBe(true);
  });

  it("two-world differential: restricted caller's results are IDENTICAL whether the bridge exists (filtered) or its edges are physically removed", async () => {
    const db = buildFixture();
    const h = harness(db, new FolderAcl(RESTRICTED_ACL));
    const worldA = await search(h); // bridge present, wired filter prunes it

    db.prepare(
      "DELETE FROM vault_edges WHERE (source_path = 'public/a.md' AND target_path = 'secret/s.md') OR (source_path = 'secret/s.md' AND target_path = 'public/b.md')",
    ).run();
    const worldB = await search(h); // bridge's edges physically gone — nothing left to filter

    expect(worldA).toEqual(worldB);
    expect(worldA.some((r) => r.path === "public/b.md")).toBe(false);
  });

  it("FAIL-CLOSED: restricted caller + acl_path_sets substrate absent -> bridge stays pruned, never silently unfiltered", async () => {
    const db = buildFixture();
    // Simulate the pre-migration / read-only-handle case THE-852's brief flags: the substrate
    // cannot serve a permitted-path set even though the rest of the schema is fully functional.
    db.exec("DROP TABLE acl_path_members");
    db.exec("DROP TABLE acl_path_sets");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(db, new FolderAcl(RESTRICTED_ACL));
    const results = await search(h);
    expect(results.some((r) => r.path === "public/b.md")).toBe(false);
    expect(results.some((r) => r.path === "public/a.md")).toBe(true); // seeds unaffected
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("substrate absent + UNRESTRICTED caller: harmless — the walk runs unfiltered exactly as before", async () => {
    const db = buildFixture();
    db.exec("DROP TABLE acl_path_members");
    db.exec("DROP TABLE acl_path_sets");
    const h = harness(db, undefined);
    const results = await search(h);
    expect(results.some((r) => r.path === "public/b.md")).toBe(true);
  });
});

// THE-891 item 3: the walk filter's recall cost, made measurable. Same fixture as above
// (public/a.md -> secret/s.md -> public/b.md) so a "pruned" count has a known right answer: 2
// (secret/s.md itself, plus public/b.md — reachable only THROUGH it).
describe("THE-891 item 3 — onAclWalkPruned prune counter", () => {
  it("restricted caller with a bridge: fires once with the count of paths the join excluded", () => {
    const db = buildFixture();
    const isReadable = (p: string) => !p.startsWith("secret/");
    const walkFilter = resolveAclWalkFilter(
      db,
      VAULT,
      new FolderAcl(RESTRICTED_ACL),
      GRANTED,
      isReadable,
    );
    // Non-vacuous: the gate this test exercises is actually open.
    expect(walkFilter.aclWalkFilter?.restricted).toBe(true);

    const pruned = vi.fn();
    const result = expandGraph({
      db,
      opts: {
        query: "q",
        queryVec: QUERY_VEC,
        vaultId: VAULT,
        isReadable,
        ...walkFilter,
        onAclWalkPruned: pruned,
      } as GraphSearchOptions,
      seedPaths: ["public/a.md"],
      seedChunkIds: new Set(),
      hopLimit: 2,
      similarityThreshold: 0.2,
      maxExpansionChunks: 50,
      decayEnabled: false,
      decayLambda: 0,
      decayNowMs: 0,
    });

    expect(pruned).toHaveBeenCalledTimes(1);
    expect(pruned).toHaveBeenCalledWith(2);
    // Non-vacuous the other way: the bridge really is gone from the returned results.
    expect(result.expansionChunks.some((c) => c.path === "public/b.md")).toBe(false);
  });

  it("unrestricted caller: never fires — the structural-no-op claim, checked empirically", () => {
    const db = buildFixture();
    const walkFilter = resolveAclWalkFilter(db, VAULT, undefined, GRANTED, () => true);
    // Non-vacuous: the gate stays closed for this caller.
    expect(walkFilter.aclWalkFilter?.restricted).toBeUndefined();

    const pruned = vi.fn();
    const result = expandGraph({
      db,
      opts: {
        query: "q",
        queryVec: QUERY_VEC,
        vaultId: VAULT,
        isReadable: () => true,
        ...walkFilter,
        onAclWalkPruned: pruned,
      } as GraphSearchOptions,
      seedPaths: ["public/a.md"],
      seedChunkIds: new Set(),
      hopLimit: 2,
      similarityThreshold: 0.2,
      maxExpansionChunks: 50,
      decayEnabled: false,
      decayLambda: 0,
      decayNowMs: 0,
    });

    expect(pruned).not.toHaveBeenCalled();
    // Non-vacuous: the bridge IS reached for this caller — nothing to prune, not a broken walk.
    expect(result.expansionChunks.some((c) => c.path === "public/b.md")).toBe(true);
  });

  it("real vault_graph_search dispatch: restricted caller's counter fires, unrestricted caller's never does", async () => {
    const events: Array<{ vault: string; count: number }> = [];
    const onAclWalkPruned = (vault: string, count: number) => events.push({ vault, count });

    const restricted = harness(buildFixture(), new FolderAcl(RESTRICTED_ACL), onAclWalkPruned);
    await search(restricted);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.vault === VAULT && e.count > 0)).toBe(true);

    events.length = 0;
    const unrestricted = harness(buildFixture(), undefined, onAclWalkPruned);
    await search(unrestricted);
    expect(events).toEqual([]);
  });
});
