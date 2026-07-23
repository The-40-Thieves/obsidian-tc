// THE-451 — agent-supplied HyDE. The client (not a server LLM) may supply a `hypothetical_answer`
// on vault_graph_search; when present it seeds the DENSE arm instead of the raw query. The
// sparse/ColBERT arms must keep seeing the raw query — HyDE is a dense-only substitution, never a
// lexical/late-interaction one. Absent/null/blank must be a byte-identical no-op vs today.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { EmbedOptions, MultiVectorEmbedding } from "../src/embeddings/provider";
import { ToolRegistry } from "../src/mcp/registry";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const VAULT = "main";

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

const root = mkdtempSync(join(tmpdir(), "obtc-hyde-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Spy embedding provider: records every text handed to embed()/embedFull(), and returns a fixed
 *  vector/multi-vector regardless of input — the wiring under test is WHICH TEXT is sent, not
 *  retrieval correctness (covered elsewhere). */
function spyProvider(opts: { sparse?: boolean; colbert?: boolean } = {}) {
  const denseCalls: string[] = [];
  const fullCalls: string[] = [];
  const provider = {
    id: "test:embed",
    provider: "ollama",
    model: "stub",
    dimensions: 4,
    embed: async (texts: string[], _o?: EmbedOptions) => {
      denseCalls.push(...texts);
      return texts.map(() => [1, 0, 0, 0]);
    },
    ...(opts.sparse || opts.colbert
      ? {
          embedFull: async (
            texts: string[],
            _o?: EmbedOptions,
          ): Promise<MultiVectorEmbedding[]> => {
            fullCalls.push(...texts);
            return texts.map(() => ({
              dense: [1, 0, 0, 0],
              sparse: { tok: 1 },
              colbert: [[1, 0]],
            }));
          },
        }
      : {}),
  };
  return { provider, denseCalls, fullCalls };
}

function harness(opts: { sparse?: boolean; colbert?: boolean } = {}) {
  const { provider, denseCalls, fullCalls } = spyProvider(opts);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]);
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider as any,
    reranker: null,
    roles: null,
    // classRouter left unset -> vault_graph_search always takes the standard (embed) path,
    // never the lexical short-circuit — exactly the path this ticket touches.
    retrieval: { sparse: opts.sparse, colbert: opts.colbert },
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:notes"]),
    vaultId: VAULT,
    db,
  };
  return { registry, ctx, denseCalls, fullCalls };
}

interface SearchData {
  vault: string;
  mode_used: string;
  query?: string;
  hyde?: boolean;
  results: unknown[];
}

describe("vault_graph_search hypothetical_answer (THE-451 agent-supplied HyDE)", () => {
  it("absent hypothetical_answer: dense arm embeds the raw query, no hyde flag", async () => {
    const { registry, ctx, denseCalls } = harness();
    const res = un<SearchData>(
      await registry.dispatch("vault_graph_search", { vault: VAULT, query: "the raw query" }, ctx),
    );
    expect(denseCalls).toEqual(["the raw query"]);
    expect(res.hyde).toBeFalsy();
  });

  it("hypothetical_answer present: dense arm embeds the hypothetical, not the query", async () => {
    const { registry, ctx, denseCalls } = harness();
    const res = un<SearchData>(
      await registry.dispatch(
        "vault_graph_search",
        {
          vault: VAULT,
          query: "the raw query",
          hypothetical_answer: "a plausible hypothetical answer text",
        },
        ctx,
      ),
    );
    expect(denseCalls).toEqual(["a plausible hypothetical answer text"]);
    expect(res.hyde).toBe(true);
    // echoed back for audit — the raw query itself must be preserved, unmodified.
    expect(res.query).toBe("the raw query");
  });

  it("sparse and ColBERT arms keep seeing the RAW query even when HyDE fires", async () => {
    const { registry, ctx, denseCalls, fullCalls } = harness({ sparse: true, colbert: true });
    await registry.dispatch(
      "vault_graph_search",
      {
        vault: VAULT,
        query: "the raw query",
        hypothetical_answer: "a plausible hypothetical answer text",
      },
      ctx,
    );
    expect(denseCalls).toEqual(["a plausible hypothetical answer text"]);
    // embedFull backs both resolveQuerySparse and resolveQueryColbert, each called once with
    // the raw query — never the hypothetical.
    expect(fullCalls).toEqual(["the raw query", "the raw query"]);
  });

  it("null hypothetical_answer is an exact no-op (same as omitted)", async () => {
    const { registry, ctx, denseCalls } = harness();
    const res = un<SearchData>(
      await registry.dispatch(
        "vault_graph_search",
        { vault: VAULT, query: "the raw query", hypothetical_answer: null },
        ctx,
      ),
    );
    expect(denseCalls).toEqual(["the raw query"]);
    expect(res.hyde).toBeFalsy();
  });

  it("whitespace-only hypothetical_answer is an exact no-op", async () => {
    const { registry, ctx, denseCalls } = harness();
    const res = un<SearchData>(
      await registry.dispatch(
        "vault_graph_search",
        { vault: VAULT, query: "the raw query", hypothetical_answer: "   " },
        ctx,
      ),
    );
    expect(denseCalls).toEqual(["the raw query"]);
    expect(res.hyde).toBeFalsy();
  });

  it("rejects a hypothetical_answer over the 4000-char bound", async () => {
    const { registry, ctx } = harness();
    const r = (await registry.dispatch(
      "vault_graph_search",
      { vault: VAULT, query: "the raw query", hypothetical_answer: "a".repeat(4001) },
      ctx,
    )) as { ok: boolean; error?: { code?: string } };
    expect(r.ok).toBe(false);
  });
});
