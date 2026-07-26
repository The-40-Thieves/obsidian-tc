// THE-448: the fan-out ENGINE shipped in PR #370 and has 16 unit tests — but nothing reached it. No
// Zod schema accepted `queries[]`, so no agent could call it, and check-boundaries.mjs allowlisted
// both modules as deliberately unreachable. An engine that works and can never be invoked is the
// same failure mode check-config-threading.mjs exists for.
//
// This drives the fan-out through the REAL registry and M7 deps, so it proves reachability rather
// than re-testing the fusion maths (multi-query-fanout.test.ts owns that).
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { indexVault } from "../src/search/indexer";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { makeM2Vault } from "./m2-helpers";

const DIMS = 32;
const GRANTED = new Set(["read:notes"]);
const OPEN_ACL: AclConfigT = { readOnly: false, defaultScopes: ["read:notes"], rules: [] };

async function harness() {
  const v = makeM2Vault({
    files: {
      "a.md": "# A\n\nalpha beta shared topic notes",
      "b.md": "# B\n\ngamma delta different subject entirely",
      "c.md": "# C\n\nalpha gamma bridging both topics together",
    },
    provider: fakeEmbeddingProvider({ dimensions: DIMS, model: "A" }),
  });
  await indexVault({
    db: v.db,
    provider: fakeEmbeddingProvider({ dimensions: DIMS, model: "A" }),
    vaultId: v.id,
    root: v.root,
    isReadable: () => true,
  });
  const registry = new ToolRegistry({});
  registerM7Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: v.id, path: v.root }]),
    embeddingProvider: fakeEmbeddingProvider({ dimensions: DIMS, model: "A" }),
    reranker: null,
    roles: null,
  });
  const ctx: CallerContext = {
    caller: "tester",
    authenticated: true,
    grantedScopes: GRANTED,
    vaultId: v.id,
    db: v.db,
    acl: new FolderAcl(OPEN_ACL),
  };
  const call = (args: Record<string, unknown>) =>
    registry.dispatch("vault_graph_search", { vault: v.id, final_top_k: 10, ...args }, ctx);
  return { v, call };
}

describe("THE-448 vault_graph_search exposes the fan-out", () => {
  it("reports the variant count so a caller can tell the fan-out actually engaged", async () => {
    // Without an echoed count, a caller cannot distinguish "fanned out over 3 phrasings" from
    // "silently ignored my queries[] and ran one search" — which is exactly how a feature ships
    // inert and nobody notices.
    const { call } = await harness();
    const r = await call({
      query: "alpha beta shared topic",
      queries: ["alpha topic notes", "shared beta subject"],
    });
    expect(r.ok).toBe(true);
    const data = (r as { data: { variants_used?: number } }).data;
    expect(data.variants_used).toBe(3); // the main query + 2 supplied phrasings
  });

  it("omits the count entirely on the ordinary single-query path", async () => {
    // The no-fan-out path must stay byte-identical to before this ticket — a field that appears
    // unconditionally would change every existing caller's response shape.
    const { call } = await harness();
    const r = await call({ query: "alpha beta shared topic" });
    expect(r.ok).toBe(true);
    expect((r as { data: Record<string, unknown> }).data).not.toHaveProperty("variants_used");
  });

  it("ALWAYS includes the main query as a variant, so paraphrases cannot drop the original", async () => {
    // A caller supplying only paraphrases must not silently lose the phrasing they actually asked
    // about. `query` is required and is the canonical intent, so it always participates.
    const { call } = await harness();
    const r = await call({
      query: "alpha beta shared topic",
      queries: ["completely other wording"],
    });
    expect((r as { data: { variants_used?: number } }).data.variants_used).toBe(2);
  });

  it("de-duplicates a supplied variant that repeats the main query", async () => {
    const { call } = await harness();
    const r = await call({
      query: "alpha beta shared topic",
      queries: ["alpha beta shared topic", "alpha topic notes"],
    });
    // 2, not 3: the repeat collapses into the main query rather than double-weighting it in RRF.
    expect((r as { data: { variants_used?: number } }).data.variants_used).toBe(2);
  });

  it("ignores blank and whitespace-only variants rather than fanning out over nothing", async () => {
    const { call } = await harness();
    const r = await call({ query: "alpha beta shared topic", queries: ["   ", ""] });
    expect(r.ok).toBe(true);
    // Every supplied variant was empty, so this collapses to the plain single-query path.
    expect((r as { data: Record<string, unknown> }).data).not.toHaveProperty("variants_used");
  });

  it("rejects an unbounded fan-out at the schema, before any search runs", async () => {
    // Cost is linear in variants: N phrasings is N full graphSearch calls. Without a cap a single
    // call could fan out arbitrarily wide, which is a denial-of-service shape, not a feature.
    const { call } = await harness();
    const r = await call({
      query: "alpha beta shared topic",
      queries: Array.from({ length: 20 }, (_, i) => `variant ${i}`),
    });
    expect(r.ok).toBe(false);
  });

  it("still returns usable results through the fan-out path", async () => {
    const { call } = await harness();
    const r = await call({
      query: "alpha beta shared topic",
      queries: ["alpha topic notes", "bridging both topics"],
    });
    const data = (r as { data: { results: Array<{ path: string }> } }).data;
    expect(data.results.length).toBeGreaterThan(0);
    for (const hit of data.results) expect(typeof hit.path).toBe("string");
  });
});
