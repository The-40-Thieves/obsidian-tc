// THE-934 fix round 3 (C) — episode-search.ts's semantic channel is a REGRESSION this PR
// introduced: `provider.embed(..., { input: "document" })` never declared `sourcePaths`, and
// round 1 wired createEmbeddingProvider's port guard to throw unconditionally on an undeclared
// sourcePaths (not merely when a path is actually excluded). semanticRankEpisodes swallows every
// error into `[]` (a provider outage should degrade hybrid search to lexical-only, not fail the
// whole call) — so the guard firing looks identical to "the provider is down", and work_search's
// semantic arm went silently empty on EVERY install, whether or not egress.excludePaths is even
// configured. Every existing test used a hand-rolled EmbeddingProvider fake (m8-experiential-
// tools.test.ts's stubProvider), never the real factory, so nothing caught it. This file builds
// the provider through the REAL createEmbeddingProvider (a fake fetchFn transport underneath, the
// same shape egress-port-guard.test.ts uses) to prove semanticRankEpisodes actually reaches it.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import type { FetchFn } from "../src/embeddings/http";
import { semanticRankEpisodes } from "../src/experiential/episode-search";

const CFG = { provider: "ollama", model: "nomic-embed-text", dimensions: 2 } as const;

/** Returns one `vector` per requested text (read off the ollama-shaped `{ input: string[] }`
 *  request body) — the real query-encoder requests exactly 1 text for `dense()` and
 *  episode-search requests N for the batched document call; a fixed-length mock response would
 *  fail `assertVectors`' length check on whichever call didn't match. */
function embedFetch(vector: number[]): { fetchFn: FetchFn; state: { calls: number } } {
  const state = { calls: 0 };
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    state.calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
    const n = body.input?.length ?? 1;
    return new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => vector) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
  return { fetchFn, state };
}

describe("episode-search semantic channel through the REAL embedding port (THE-934 fix round 3, C)", () => {
  it("finds a semantic hit through createEmbeddingProvider — the regression: this used to always return []", async () => {
    const { fetchFn, state } = embedFetch([1, 0]);
    // No excludeFilter passed at all -- egress.excludePaths unconfigured is the DEFAULT install
    // shape, and the port guard still fires unconditionally on an undeclared sourcePaths
    // regardless of whether any filter is configured (assertSourcePathsAllowed throws on
    // `undefined` before it ever looks at the filter's patterns).
    const provider = createEmbeddingProvider(CFG, { fetchFn });
    const ids = await semanticRankEpisodes(provider, "query text", [
      { id: "e1", summary: "a matching summary" },
      { id: "e2", summary: null },
    ]);
    expect(ids).toEqual(["e1"]);
    expect(state.calls).toBeGreaterThan(0);
  });
});
