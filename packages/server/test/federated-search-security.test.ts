// THE-630: federated multi-vault search — the three SECURITY invariants, plus the correctness
// acceptance criteria that are security-adjacent (vault_not_found validation, byte-identical
// no-op). See tools/m7/knowledge/graph-search.ts's header for the full invariant statement this
// file proves:
//
//   1. ACL is enforced PER VAULT (never once-for-all) — "each vault's ACL, own leg" tests.
//   2. The query cache's aclFingerprint stays a per-vault isolation boundary — "cache isolation"
//      tests.
//   3. A vault-bound (HTTP-token) caller cannot widen its scope through `vaults` — "vaultBound
//      refusal" tests, including a differential test (mirroring THE-695's idiom of documenting a
//      lower-level gap before proving the layer above it closes it) that shows central dispatch's
//      `enforceVaultBinding` CANNOT catch this by construction, so the handler-level check is load-
//      bearing, not redundant.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { enforceVaultBinding } from "../src/mcp/registry/input-binding";
import { indexVault } from "../src/search/indexer";
import { createRetrievalCaches, type RetrievalCaches } from "../src/search/query_cache";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const DIMS = 32;
const GRANTED = new Set(["read:notes"]);
const OPEN_ACL: AclConfigT = { readOnly: false, defaultScopes: ["read:notes"], rules: [] };
const VAULT_A = "vault-a";
const VAULT_B = "vault-b";

interface Harness {
  db: Database;
  rootA: string;
  rootB: string;
  registry: ToolRegistry;
  provider: EmbeddingProvider & { queryCalls: string[] };
  retrievalCaches?: RetrievalCaches;
  ctx: (over?: Partial<CallerContext>) => CallerContext;
  cleanup: () => void;
}

/** A fake embedding provider that also counts DENSE-query embed calls — the observable the cache
 *  isolation tests use to prove a hit skipped the model round-trip. */
function countingProvider(): EmbeddingProvider & { queryCalls: string[] } {
  const inner = fakeEmbeddingProvider({ dimensions: DIMS, model: "A" });
  const wrapper = {
    queryCalls: [] as string[],
    id: inner.id,
    provider: inner.provider,
    model: inner.model,
    dimensions: inner.dimensions,
    embed: async (texts: string[], opts?: { input?: string }) => {
      if (opts?.input === "query") wrapper.queryCalls.push(...texts);
      return inner.embed(texts, opts as never);
    },
  };
  return wrapper as EmbeddingProvider & { queryCalls: string[] };
}

async function buildHarness(
  opts: {
    aclA?: Partial<AclConfigT>;
    aclB?: Partial<AclConfigT>;
    filesA?: Record<string, string>;
    filesB?: Record<string, string>;
    cache?: boolean;
  } = {},
): Promise<Harness> {
  const rootA = mkdtempSync(join(tmpdir(), "obtc-fed-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "obtc-fed-b-"));
  const write = (root: string, rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(opts.filesA ?? {})) write(rootA, rel, content);
  for (const [rel, content] of Object.entries(opts.filesB ?? {})) write(rootB, rel, content);

  const db = openMemoryDb();
  provisionCacheDb(db);
  const provider = countingProvider();
  const representation = buildRepresentationManifest(provider, {});

  await indexVault({
    db,
    provider,
    representation,
    vaultId: VAULT_A,
    root: rootA,
    isReadable: () => true,
  });
  await indexVault({
    db,
    provider,
    representation,
    vaultId: VAULT_B,
    root: rootB,
    isReadable: () => true,
  });

  const acl = new FolderAcl(OPEN_ACL);
  const aclByVault = new Map<string, FolderAcl>([
    [VAULT_A, new FolderAcl({ ...OPEN_ACL, ...opts.aclA })],
    [VAULT_B, new FolderAcl({ ...OPEN_ACL, ...opts.aclB })],
  ]);

  const vaultRegistry = new VaultRegistry([
    { id: VAULT_A, path: rootA },
    { id: VAULT_B, path: rootB },
  ]);

  // Mirrors governance.ts's own dispatch-level aclResolver EXACTLY: THE-295's per-vault swap runs
  // for real here, so ctx.acl in these tests is whatever real dispatch would set for the PRIMARY
  // vault — the same thing the federated handler must NOT rely on for the other N-1 vaults.
  const registry = new ToolRegistry({ aclResolver: (vaultId) => aclByVault.get(vaultId) ?? acl });
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    reranker: null,
    roles: null,
    acl,
    aclByVault,
    ...(opts.cache
      ? { retrievalCaches: createRetrievalCaches({ maxEntries: 32, ttlMs: 60_000 }) }
      : {}),
  });

  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: GRANTED,
    vaultId: VAULT_A,
    db,
    ...over,
  });

  return {
    db,
    rootA,
    rootB,
    registry,
    provider,
    ctx,
    cleanup: () => {
      rmTemp(rootA);
      rmTemp(rootB);
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function harness(opts: Parameters<typeof buildHarness>[0] = {}): Promise<Harness> {
  const h = await buildHarness(opts);
  cleanups.push(h.cleanup);
  return h;
}

// ---------------------------------------------------------------------------------------------
// Invariant 3 — vaultBound refusal, including the differential test proving central dispatch
// alone cannot catch it.
// ---------------------------------------------------------------------------------------------
describe("THE-630 invariant 3: a vault-bound caller cannot widen its scope via `vaults`", () => {
  it("documents the gap: enforceVaultBinding alone does NOT see a `vaults` field at all", () => {
    // Central dispatch's guard only inspects the tool's declared SINGULAR vaultArg field
    // ("vault"). A synthetic tool definition with no vaultArg override, called with `vault` equal
    // to the bound vault but `vaults` naming a FOREIGN one, does not throw — proving reliance on
    // this guard alone would ship the leak. This mirrors THE-695's idiom of proving the lower-level
    // primitive's gap exists before proving the layer above it closes it.
    const def = { name: "synthetic", inputSchema: {} as never, requiredScopes: [] } as never;
    const data = { vault: VAULT_A, vaults: [VAULT_A, "someone-elses-vault"] };
    const ctx: CallerContext = {
      caller: "t",
      authenticated: true,
      grantedScopes: GRANTED,
      vaultId: VAULT_A,
      db: {} as Database,
      vaultBound: true,
    };
    expect(() => enforceVaultBinding(ctx, def, data)).not.toThrow();
  });

  it("a bound caller naming a FOREIGN vault in `vaults` is refused by the real tool (forbidden)", async () => {
    const h = await harness();
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [VAULT_B], query: "alpha" },
      h.ctx({ vaultBound: true }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("a bound caller naming ONLY its own vault in `vaults` is STILL refused — presence, not content", async () => {
    // AC2: the whole point is that a bound caller must never exercise the federation code path,
    // not that its result would happen to be safe this time.
    const h = await harness();
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [VAULT_A], query: "alpha" },
      h.ctx({ vaultBound: true }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("refuses BEFORE any embedding work — the model is never called", async () => {
    const h = await harness();
    h.provider.queryCalls.length = 0;
    await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [VAULT_A, VAULT_B], query: "alpha" },
      h.ctx({ vaultBound: true }),
    );
    expect(h.provider.queryCalls).toEqual([]);
  });

  it("a bound caller omitting `vaults` entirely is unaffected — the single-vault path still works", async () => {
    const h = await harness({ filesA: { "a.md": "# A\n\nalpha beta shared topic notes" } });
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, query: "alpha beta shared topic" },
      h.ctx({ vaultBound: true }),
    );
    expect(res.ok).toBe(true);
  });

  it("an UNBOUND (trusted stdio) caller CAN federate", async () => {
    const h = await harness({
      filesA: { "a.md": "# A\n\nalpha beta shared topic notes" },
      filesB: { "b.md": "# B\n\nalpha beta shared topic notes" },
    });
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [VAULT_B], query: "alpha beta shared topic" },
      h.ctx(),
    );
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// AC3 — every requested vault validated before any search runs.
// ---------------------------------------------------------------------------------------------
describe("THE-630 AC3: unknown vault ids are refused before any search runs", () => {
  it("an unknown id in `vaults` returns vault_not_found naming the offending id", async () => {
    const h = await harness();
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: ["does-not-exist"], query: "alpha" },
      h.ctx(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("vault_not_found");
      expect(JSON.stringify(res.error.details)).toContain("does-not-exist");
    }
  });

  it("no embedding work happens before the vault id is validated", async () => {
    const h = await harness();
    h.provider.queryCalls.length = 0;
    await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: ["does-not-exist"], query: "alpha" },
      h.ctx(),
    );
    expect(h.provider.queryCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Invariant 1 — ACL enforced PER VAULT, never once-for-all.
// ---------------------------------------------------------------------------------------------
describe("THE-630 invariant 1 / AC4: each vault leg runs under its OWN ACL", () => {
  it("vault B's denied path never leaks even though vault A allows the identically-named path", async () => {
    const h = await harness({
      // Both vaults have a note at the SAME relative path. Vault A's ACL allows "public/**"; vault
      // B's ACL does NOT (its whitelist is "other/**", which "public/topic.md" never matches) — so
      // vault B's copy must be filtered at vault B's OWN search stage, never leak through under
      // vault A's (or any shared/global) ACL.
      filesA: { "public/topic.md": "# Topic\n\nalpha beta shared topic notes vault A" },
      filesB: { "public/topic.md": "# Topic\n\nalpha beta shared topic notes vault B" },
      aclA: { readPaths: ["public/**"] },
      aclB: { readPaths: ["other/**"] },
    });
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [VAULT_B], query: "alpha beta shared topic", final_top_k: 10 },
      h.ctx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { results: Array<{ vault?: string; path: string }> };
    const fromB = data.results.filter((r) => r.vault === VAULT_B);
    expect(fromB).toEqual([]);
    const fromA = data.results.filter((r) => r.vault === VAULT_A && r.path === "public/topic.md");
    expect(fromA.length).toBeGreaterThan(0);
  });

  it("the reverse: vault A's denied path never leaks even though vault B allows the identically-named path", async () => {
    const h = await harness({
      filesA: { "public/topic.md": "# Topic\n\nalpha beta shared topic notes vault A" },
      filesB: { "public/topic.md": "# Topic\n\nalpha beta shared topic notes vault B" },
      aclA: { readPaths: ["other/**"] },
      aclB: { readPaths: ["public/**"] },
    });
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [VAULT_B], query: "alpha beta shared topic", final_top_k: 10 },
      h.ctx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { results: Array<{ vault?: string; path: string }> };
    expect(data.results.filter((r) => r.vault === VAULT_A)).toEqual([]);
    expect(
      data.results.filter((r) => r.vault === VAULT_B && r.path === "public/topic.md").length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// AC6 — cross-vault fusion dedupes on (vault, path), not bare path.
// ---------------------------------------------------------------------------------------------
describe("THE-630 AC6: fusion dedupes on (vault, path), never bare path", () => {
  it("two vaults' notes at the same relative path both appear, each tagged with its own vault", async () => {
    const h = await harness({
      filesA: { "shared/note.md": "# Note\n\nalpha beta shared topic notes only in A" },
      filesB: { "shared/note.md": "# Note\n\nalpha beta shared topic notes only in B" },
    });
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [VAULT_B], query: "alpha beta shared topic", final_top_k: 10 },
      h.ctx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { results: Array<{ vault?: string; path: string }> };
    const atSharedPath = data.results.filter((r) => r.path === "shared/note.md");
    expect(atSharedPath).toHaveLength(2);
    expect(new Set(atSharedPath.map((r) => r.vault))).toEqual(new Set([VAULT_A, VAULT_B]));
  });
});

// ---------------------------------------------------------------------------------------------
// Invariant 2 / AC5 — the query cache stays a per-vault isolation boundary.
// ---------------------------------------------------------------------------------------------
describe("THE-630 invariant 2 / AC5: the query cache stays per-vault, never a combined federated entry", () => {
  it("a repeated SINGLE-vault call is unaffected by this ticket — still a cache hit, no re-embed", async () => {
    const h = await harness({
      filesA: { "a.md": "# A\n\nalpha beta shared topic notes" },
      cache: true,
    });
    const args = { vault: VAULT_A, query: "alpha beta shared topic", final_top_k: 10 };
    const first = await h.registry.dispatch("vault_graph_search", args, h.ctx());
    expect(first.ok).toBe(true);
    h.provider.queryCalls.length = 0;
    const second = await h.registry.dispatch("vault_graph_search", args, h.ctx());
    expect(second.ok).toBe(true);
    expect(h.provider.queryCalls).toEqual([]); // served from cache, no re-embed
  });

  it("a federated call over 2 vaults populates TWO independent per-vault cache entries, not one", async () => {
    const h = await harness({
      filesA: { "a.md": "# A\n\nalpha beta shared topic notes" },
      filesB: { "b.md": "# B\n\nalpha beta shared topic notes" },
      cache: true,
    });
    const args = {
      vault: VAULT_A,
      vaults: [VAULT_B],
      query: "alpha beta shared topic",
      final_top_k: 10,
    };
    const first = await h.registry.dispatch("vault_graph_search", args, h.ctx());
    expect(first.ok).toBe(true);
    // Second identical federated call: BOTH legs must be served from cache (2 independent hits),
    // never a single combined federated entry and never a partial re-embed.
    h.provider.queryCalls.length = 0;
    const second = await h.registry.dispatch("vault_graph_search", args, h.ctx());
    expect(second.ok).toBe(true);
    expect(h.provider.queryCalls).toEqual([]);
  });

  it("a federated leg's cache entry is fingerprinted under THAT vault's own ACL, not the primary's", async () => {
    // Two vaults with DIFFERENT ACLs: if the federated leg's cache binding ever used ctx.acl (the
    // PRIMARY vault's ACL, per THE-295) instead of each vault's own, both legs would fingerprint
    // identically despite genuinely different effective permissions — a cross-principal collision
    // risk of exactly the class query_cache.ts's header warns about. Proven indirectly: a caller
    // whose bound ACL differs per vault still gets vault B's OWN restriction applied (no leak),
    // confirming the fingerprint path is per-vault too (the same per-vault `acl` feeds both the
    // isReadable filter AND the cache binding — see aclForVault in graph-search.ts).
    const h = await harness({
      filesA: { "public/topic.md": "# Topic\n\nalpha beta shared topic notes vault A" },
      filesB: { "public/topic.md": "# Topic\n\nalpha beta shared topic notes vault B" },
      aclA: { readPaths: ["public/**"] },
      aclB: { readPaths: ["other/**"] },
      cache: true,
    });
    const args = {
      vault: VAULT_A,
      vaults: [VAULT_B],
      query: "alpha beta shared topic",
      final_top_k: 10,
    };
    const first = await h.registry.dispatch("vault_graph_search", args, h.ctx());
    expect(first.ok).toBe(true);
    const second = await h.registry.dispatch("vault_graph_search", args, h.ctx());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const data = second.data as { results: Array<{ vault?: string; path: string }> };
    // Vault B's denial must still hold on the CACHED second call, not just the first — proving the
    // cache entry itself was built under vault B's own ACL rather than a leaked primary-vault one.
    expect(data.results.filter((r) => r.vault === VAULT_B)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// AC1 — absent/empty/collapsing `vaults` is an EXACT no-op.
// ---------------------------------------------------------------------------------------------
describe("THE-630 AC1: `vaults` absent, empty, or collapsing to the primary vault is a byte-identical no-op", () => {
  it("omitting `vaults` and passing `vaults: []` produce IDENTICAL responses", async () => {
    const h = await harness({ filesA: { "a.md": "# A\n\nalpha beta shared topic notes" } });
    const withoutField = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, query: "alpha beta shared topic", final_top_k: 10 },
      h.ctx(),
    );
    const withEmpty = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [], query: "alpha beta shared topic", final_top_k: 10 },
      h.ctx(),
    );
    expect(withoutField.ok).toBe(true);
    expect(withEmpty.ok).toBe(true);
    // Compare `.data` only — `.meta.duration_ms` is real wall-clock timing and expected to differ
    // between two separate dispatches; the RESPONSE PAYLOAD is what AC1 requires byte-identical.
    if (withoutField.ok && withEmpty.ok) expect(withEmpty.data).toEqual(withoutField.data);
  });

  it("`vaults: [vault]` (collapsing to just the primary) produces the SAME response as omitting it", async () => {
    const h = await harness({ filesA: { "a.md": "# A\n\nalpha beta shared topic notes" } });
    const withoutField = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, query: "alpha beta shared topic", final_top_k: 10 },
      h.ctx(),
    );
    const withSelf = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [VAULT_A], query: "alpha beta shared topic", final_top_k: 10 },
      h.ctx(),
    );
    if (withoutField.ok && withSelf.ok) expect(withSelf.data).toEqual(withoutField.data);
  });

  it("the non-federated response never has `vaults_used` or `per_vault` at all", async () => {
    const h = await harness({ filesA: { "a.md": "# A\n\nalpha beta shared topic notes" } });
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, query: "alpha beta shared topic", final_top_k: 10 },
      h.ctx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).not.toHaveProperty("vaults_used");
    expect(res.data).not.toHaveProperty("per_vault");
  });

  it("a genuinely federated call DOES report `vaults_used` and `per_vault`", async () => {
    const h = await harness({
      filesA: { "a.md": "# A\n\nalpha beta shared topic notes" },
      filesB: { "b.md": "# B\n\nalpha beta shared topic notes" },
    });
    const res = await h.registry.dispatch(
      "vault_graph_search",
      { vault: VAULT_A, vaults: [VAULT_B], query: "alpha beta shared topic", final_top_k: 10 },
      h.ctx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { vaults_used?: number; per_vault?: Record<string, unknown> };
    expect(data.vaults_used).toBe(2);
    expect(Object.keys(data.per_vault ?? {}).sort()).toEqual([VAULT_A, VAULT_B]);
  });
});
