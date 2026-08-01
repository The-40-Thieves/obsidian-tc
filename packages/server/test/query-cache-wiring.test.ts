// THE-497: the cache reaching the actual MCP tool surface, not just its own unit tests. A primitive
// that works and is never called is the failure mode `check-config-threading.mjs` exists for, and a
// cache is especially easy to ship inert — nothing breaks, the latency is just unchanged.
//
// So this drives `vault_graph_search` through the real registry with the real M7 deps and counts
// EMBED CALLS at the provider: a hit must reach neither the model nor the DB, a different caller
// must reach both, and with the cache absent every call must embed exactly as before.
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { indexVault } from "../src/search/indexer";
import { createRetrievalCaches } from "../src/search/query_cache";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { makeM2Vault } from "./m2-helpers";

const DIMS = 32;
const GRANTED = new Set(["read:notes"]);
const QUERY = "alpha beta shared topic";

const OPEN_ACL: AclConfigT = { readOnly: false, defaultScopes: ["read:notes"], rules: [] };
const RESTRICTED_ACL: AclConfigT = {
  readOnly: false,
  defaultScopes: ["read:notes"],
  rules: [],
  readPaths: ["public/**"],
};

/** The deterministic fake provider, wrapped to count query embeddings — the observable that says
 *  whether a cache hit really skipped the model round-trip. */
function countingProvider(): EmbeddingProvider & { calls: number } {
  const inner = fakeEmbeddingProvider({ dimensions: DIMS, model: "A" });
  const wrapper = {
    calls: 0,
    id: inner.id,
    provider: inner.provider,
    model: inner.model,
    dimensions: inner.dimensions,
    embed: async (texts: string[], opts?: { input?: string }) => {
      if (opts?.input === "query") wrapper.calls++;
      return inner.embed(texts, opts as never);
    },
  };
  return wrapper as EmbeddingProvider & { calls: number };
}

async function harness(opts: { cached: boolean }) {
  const v = makeM2Vault({
    files: {
      "public/open.md": "# Open\n\nalpha beta shared topic notes",
      "secret/closed.md": "# Closed\n\nalpha beta shared topic classified",
    },
    provider: fakeEmbeddingProvider({ dimensions: DIMS, model: "A" }),
  });
  await indexVault({
    db: v.db,
    provider: fakeEmbeddingProvider({ dimensions: DIMS, model: "A" }),
    representation: buildRepresentationManifest(
      fakeEmbeddingProvider({ dimensions: DIMS, model: "A" }),
      {},
    ),
    vaultId: v.id,
    root: v.root,
    isReadable: () => true,
  });

  const provider = countingProvider();
  const registry = new ToolRegistry({});
  registerM7Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: v.id, path: v.root }]),
    embeddingProvider: provider,
    reranker: null,
    roles: null,
    ...(opts.cached
      ? { retrievalCaches: createRetrievalCaches({ maxEntries: 16, ttlMs: 60_000 }) }
      : {}),
  });

  const ctxFor = (acl: AclConfigT): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: GRANTED,
    vaultId: v.id,
    db: v.db,
    acl: new FolderAcl(acl),
  });

  const search = async (acl: AclConfigT) => {
    const res = await registry.dispatch(
      "vault_graph_search",
      { vault: v.id, query: QUERY, final_top_k: 10 },
      ctxFor(acl),
    );
    return (res as { data: { results: Array<{ path: string }> } }).data.results;
  };

  return { v, provider, search };
}

describe("THE-497 cache wiring through the MCP tool surface", () => {
  it("serves a repeat query from cache without touching the embedding provider", async () => {
    const { v, provider, search } = await harness({ cached: true });
    const first = await search(OPEN_ACL);
    expect(first.length).toBeGreaterThan(0);
    expect(provider.calls).toBe(1);

    const second = await search(OPEN_ACL);
    expect(second.map((r) => r.path)).toEqual(first.map((r) => r.path));
    expect(provider.calls).toBe(1); // the hit skipped the model entirely
    v.cleanup();
  });

  it("does not serve a broad caller's results to a restricted one", async () => {
    const { v, provider, search } = await harness({ cached: true });
    const open = await search(OPEN_ACL);
    expect(open.some((r) => r.path.startsWith("secret/"))).toBe(true);

    const restricted = await search(RESTRICTED_ACL);
    expect(restricted.some((r) => r.path.startsWith("secret/"))).toBe(false);
    expect(restricted.some((r) => r.path.startsWith("public/"))).toBe(true);
    expect(provider.calls).toBe(2); // a real second retrieval, not a filtered replay
    v.cleanup();
  });

  it("is inert when retrieval.cache is off — every call embeds, exactly as before THE-497", async () => {
    const { v, provider, search } = await harness({ cached: false });
    const first = await search(OPEN_ACL);
    const second = await search(OPEN_ACL);
    expect(second.map((r) => r.path)).toEqual(first.map((r) => r.path));
    expect(provider.calls).toBe(2);
    v.cleanup();
  });
});
