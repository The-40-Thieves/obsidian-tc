// WP2.3: the `vault_graph_search` tool factory, extracted verbatim out of buildKnowledgeTools.
// Takes the shared retrieval runtime constructed once in buildKnowledgeTools rather than building
// its own embedder, cache, or policy state — see RetrievalRuntime's doc comment in
// retrieval-runtime.ts. Uses retrieval.embedAll on both the cached and fan-out (THE-448) paths.
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import type { GraphSearchResult } from "../../../search/graph_search";
import { multiQueryGraphSearch } from "../../../search/multi_query";
import { cachedGraphSearch } from "../../../search/query_cache";
import { lexicalRouteResults, routeQuery } from "../../../search/router";
import { readableRel, readEnumerationUnrestricted } from "../../../vault/acl-read-filter";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import {
  buildGraphSearchOptions,
  cacheContextFor,
  captureCoverage,
  capturePolicy,
  type RetrievalRuntime,
  retrievalHits,
} from "./retrieval-runtime";
import { VaultGraphSearchOutput } from "./schemas";

export function createGraphSearchTool(deps: M7Deps, retrieval: RetrievalRuntime): ToolDefinition {
  return defineTool({
    name: "vault_graph_search",
    domain: "knowledge",
    description:
      "Cross-domain / multi-hop semantic search with wikilink graph expansion (GraphRAG). Seeds by vector similarity, expands through the links_to graph (vault_edges), and fuses by RRF. Run index_vault first so the edge graph is populated. Returns chunks tagged seed|expansion with hop + via_edge.",
    inputSchema: z
      .object({
        vault: VaultId,
        query: z.string().min(1),
        // THE-451: agent-supplied HyDE (Gao 2023). MCP-native — the CLIENT writes the
        // hypothetical answer; there is no server-side LLM generating it here. When present,
        // it replaces the query as the DENSE-arm seed only (see below); sparse/ColBERT keep
        // the raw query untouched. No min() bound: an empty/whitespace-only value must be a
        // silent no-op (not a validation error), so length-gating happens in the handler.
        // Measurement-fragile per the ticket: HyDE helps under-specified/zero-shot queries and
        // can HURT a strong encoder on well-specified queries (our nomic-768 + golden set is
        // squarely the latter). This is an opt-in lever for the CALLER to reach for on vague
        // queries — never make it the default path.
        hypothetical_answer: z.string().max(4000).optional().nullable(),
        // THE-448: agent-supplied phrasing VARIANTS. Like hypothetical_answer above this is
        // MCP-native — the CLIENT writes the paraphrases; no server LLM generates them. Each
        // variant gets its own full graphSearch and the ranked lists are fused across variants by
        // rank-based RRF (see search/multi_query.ts for why rank and not score).
        //
        // The main `query` is ALWAYS included as a variant, so supplying only paraphrases cannot
        // silently drop the phrasing the caller actually asked about.
        //
        // Capped at 8: cost is LINEAR in variants — N phrasings is N complete searches — so an
        // unbounded array is a denial-of-service shape rather than a feature. Blank entries are
        // ignored, and a set that collapses to one distinct query is an exact no-op.
        //
        // Gains concentrate on compound / multi-facet queries and are roughly neutral on
        // single-fact ones, while always costing latency and agent tokens. Opt-in per call.
        queries: z.array(z.string().max(1000)).max(8).optional(),
        final_top_k: z.number().int().positive().max(100).default(30),
      })
      .strict(),
    outputSchema: VaultGraphSearchOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "search"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      // THE-451: trim-and-check so null/absent/blank are all byte-identical to no HyDE.
      const hyde = input.hypothetical_answer?.trim();
      const hydeActive = !!hyde;
      // THE-258: class router (dark unless retrieval.classRouter). The lexical class
      // short-circuits BEFORE the embedding round-trip — the router's cost win; temporal
      // auto-enables the THE-221 stream; standard falls through unchanged.
      const route = deps.classRouter
        ? routeQuery(ctx.db, v.id, input.query, {
            isReadable: (p) => readableRel(ctx.acl, p),
            // THE-694: the rare-term probe is only issued for callers who can read everything.
            readUnrestricted: readEnumerationUnrestricted(ctx.acl),
          })
        : { class: "standard" as const, signals: [] as string[] };
      const policy = capturePolicy(deps, v.id, route.class);
      const coverage = captureCoverage();
      if (route.class === "lexical") {
        const results = lexicalRouteResults(ctx.db, v.id, input.query, input.final_top_k, (rel) =>
          readableRel(ctx.acl, rel),
        );
        deps.retrievalLog?.({
          queryText: input.query,
          surfaceType: "vault_graph_search",
          sessionId: ctx.sessionId ?? null,
          caller: ctx.caller ?? null,
          hits: retrievalHits(results),
          policy: policy.record(route.class === "lexical" ? "lexical-route" : "static"),
        });
        return {
          vault: v.id,
          mode_used: "lexical-route",
          route: route.signals,
          ...(hydeActive ? { query: input.query, hyde: true } : {}),
          results,
        };
      }
      // THE-451: the dense arm embeds the hypothetical answer when supplied; sparse/ColBERT
      // ALWAYS embed the raw query — HyDE seeds the dense vector only, it must never
      // contaminate lexical or late-interaction matching.
      // THE-497: that split is exactly why the cache takes an explicit `denseText` — the raw
      // query rides `query` for the lexical arms, so it alone would not distinguish two calls
      // that differ only in their hypothetical answer.
      const denseText = hydeActive ? (hyde as string) : input.query;
      const searchOptions = buildGraphSearchOptions(deps, {
        route,
        query: input.query,
        vaultId: v.id,
        finalTopK: input.final_top_k,
        reranker: deps.reranker,
        isReadable: (rel) => readableRel(ctx.acl, rel),
        onFusionWeights: policy.sink,
        onCoverage: coverage.sink,
      });
      // THE-448: the main query ALWAYS leads, then the supplied phrasings, blanks dropped and
      // duplicates collapsed — a repeat must not double-weight itself in the cross-variant RRF.
      // One distinct query means no fan-out at all, which is the engine's exact no-op path.
      const variants = [
        ...new Set([input.query, ...(input.queries ?? [])].map((q) => q.trim())),
      ].filter((q) => q.length > 0);
      const fanOut = variants.length > 1;
      let results: GraphSearchResult[];
      if (fanOut) {
        // The fan-out varies query TEXT, never the embedding: every variant runs against the same
        // vectors (multi_query.ts's module header explains why, and why that still changes the
        // per-variant ranking). So embed once, here, rather than per variant.
        //
        // This path deliberately bypasses THE-497's query cache: multiQueryGraphSearch calls
        // graphSearch directly, so a fan-out neither reads nor populates it. That keeps N variants
        // from evicting the cache in one call, at the cost of not serving a repeated identical
        // fan-out from cache. Revisit if fan-out ever becomes a hot path.
        const vectors = await retrieval.embedAll(denseText, input.query);
        // Named rather than spread inline at the call: the THE-545 gate reads a `{` directly after
        // `ctx.db,` as a hand-assembled options object, and it is right to — that is what it exists
        // to catch. These options DO come from the builder; naming them says so and keeps the gate
        // protective instead of relaxed.
        const fanOutOptions = { ...searchOptions, ...vectors };
        results = await multiQueryGraphSearch(ctx.db, fanOutOptions, variants);
      } else {
        results = await cachedGraphSearch(
          ctx.db,
          searchOptions,
          () => retrieval.embedAll(denseText, input.query),
          cacheContextFor(deps, ctx, v.id, denseText),
        );
      }
      // THE-230: serve-path retrieval telemetry (best-effort; the logger never throws).
      deps.retrievalLog?.({
        queryText: input.query,
        surfaceType: "vault_graph_search",
        sessionId: ctx.sessionId ?? null,
        caller: ctx.caller ?? null,
        hits: retrievalHits(results),
        // The lexical class returned early above, so this path always fused.
        policy: policy.record("static"),
      });
      return {
        vault: v.id,
        mode_used: "graph",
        // THE-451: echo `query` (audit — what the caller actually asked) and mark hyde:true
        // only when it fired; absent otherwise so existing callers see no new field.
        ...(hydeActive ? { query: input.query, hyde: true } : {}),
        // THE-448: present ONLY when the fan-out actually engaged, matching the hyde convention
        // above — an unconditional field would change every existing caller's response shape.
        // Echoed because without it a caller cannot distinguish "fanned out over 3 phrasings"
        // from "silently ignored queries[] and ran one search", which is how a feature ships
        // inert and nobody notices.
        ...(fanOut ? { variants_used: variants.length } : {}),
        // THE-631: present only when graphSearch actually ran (absent on a query-cache HIT,
        // which never calls it — see query_cache.ts's FUNCTION_FIELDS comment on onCoverage).
        ...(coverage.get() ? { coverage: coverage.get() } : {}),
        results,
      };
    },
  });
}
