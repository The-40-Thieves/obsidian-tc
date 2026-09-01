// WP2.3: the `knowledge_search` tool factory, extracted verbatim out of buildKnowledgeTools.
// Takes the shared retrieval runtime constructed once in buildKnowledgeTools rather than building
// its own embedder, cache, or policy state — see RetrievalRuntime's doc comment in
// retrieval-runtime.ts. Uses retrieval.embedAll on the cached graph-search path.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
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
  resolveAclWalkFilter,
  retrievalHits,
} from "./retrieval-runtime";
import { KnowledgeSearchOutput } from "./schemas";

export function createKnowledgeSearchTool(
  deps: M7Deps,
  retrieval: RetrievalRuntime,
): ToolDefinition {
  return defineTool({
    name: "knowledge_search",
    domain: "docs",
    description:
      "Semantic + keyword search over a vendor / external-docs corpus (a reserved read-only docs vault), with wikilink graph expansion and RRF fusion. The docs-scoped analogue of vault_graph_search: bind `vault` to the docs corpus id. Returns source-attributed chunks tagged seed|expansion. Gated on read:docs so it stays isolated from the private vault.",
    inputSchema: z
      .object({
        vault: VaultId,
        query: z.string().min(1),
        final_top_k: z.number().int().positive().max(100).default(20),
        // THE-635: point-in-time filter — see search/point_in_time.ts's module doc for the "why"
        // and the honest-history contract (a chunk existing at D but edited since is INCLUDED and
        // flagged `changed_since_d: true`, never silently presented as the D-state). Absent
        // (default): today's behavior, byte-for-byte unchanged — the filter never runs.
        as_of: z.number().int().nonnegative().optional(),
        // Window floor (applied to updated_at); only meaningful paired with `as_of` — validated in
        // the handler below. Defaults to 0 (no lower bound) when `as_of` is given without it.
        since: z.number().int().nonnegative().optional(),
      })
      .strict(),
    outputSchema: KnowledgeSearchOutput,
    requiredScopes: ["read:docs"],
    tags: ["docs", "search", "knowledge"],
    handler: async (input, ctx) => {
      // THE-635: validate before any DB/embedding work — a clean error, never a silently-ignored
      // or silently-clamped input.
      if (input.since !== undefined && input.as_of === undefined) {
        throw err.invalidInput("since requires as_of", { since: input.since });
      }
      if (input.as_of !== undefined && input.since !== undefined && input.since > input.as_of) {
        throw err.invalidInput("since must be <= as_of", {
          since: input.since,
          as_of: input.as_of,
        });
      }
      const asOf = input.as_of;
      const since = asOf !== undefined ? (input.since ?? 0) : undefined;
      const v = deps.vaultRegistry.resolve(input.vault);
      // P1.5: the read:docs surface is code-bound to a docs-kind vault, so a misprovisioned
      // docs token cannot read the private vault even if it names its id.
      if (v.kind !== "docs")
        throw err.forbidden("knowledge_search operates only on a docs-kind vault", {
          vault: v.id,
          kind: v.kind,
        });
      let route = deps.classRouter
        ? routeQuery(ctx.db, v.id, input.query, {
            isReadable: (p) => readableRel(ctx.acl, p),
            // THE-694: the rare-term probe is only issued for callers who can read everything.
            readUnrestricted: readEnumerationUnrestricted(ctx.acl),
          })
        : { class: "standard" as const, signals: [] as string[] };
      // THE-635: the lexical short-circuit below bypasses candidateAssembly entirely, which is
      // where the point-in-time PRE-filter lives — an as_of query must never take that route, or a
      // chunk that did not exist at D would leak through unfiltered. Force the graph/fusion path
      // instead; classRouter is dark by default so this branch is inert on most deployments.
      if (asOf !== undefined && route.class === "lexical") {
        route = { class: "standard", signals: route.signals };
      }
      const policy = capturePolicy(deps, v.id, route.class);
      const coverage = captureCoverage();
      if (route.class === "lexical") {
        // THE-853: resolve the caller's ACL partition so the lexical-route bm25Chunks call takes
        // the exact JOIN path (or fails closed) instead of the leaky over-fetch fallback — same
        // resolution the "standard" route gets for free inside buildGraphSearchOptions below.
        const walkFilter = resolveAclWalkFilter(ctx.db, v.id, ctx.acl, ctx.grantedScopes, (rel) =>
          readableRel(ctx.acl, rel),
        );
        const results = lexicalRouteResults(
          ctx.db,
          v.id,
          input.query,
          input.final_top_k,
          (rel) => readableRel(ctx.acl, rel),
          walkFilter.aclSetId,
          walkFilter.aclWalkFilter?.blocked,
        );
        deps.retrievalLog?.({
          queryText: input.query,
          surfaceType: "knowledge_search",
          sessionId: ctx.sessionId ?? null,
          caller: ctx.caller ?? null,
          hits: retrievalHits(results),
          policy: policy.record(route.class === "lexical" ? "lexical-route" : "static"),
        });
        return { vault: v.id, mode_used: "lexical-route", route: route.signals, results };
      }
      const results = await cachedGraphSearch(
        ctx.db,
        buildGraphSearchOptions(deps, {
          route,
          query: input.query,
          vaultId: v.id,
          finalTopK: input.final_top_k,
          // THE-441: reranking lost decisively to the champion on this stack; the docs corpus
          // never reranks, independent of any server-side reranker config. Passed explicitly so
          // this stays a visible decision rather than looking like a dropped option.
          reranker: null,
          isReadable: (rel) => readableRel(ctx.acl, rel),
          db: ctx.db,
          acl: ctx.acl,
          grantedScopes: ctx.grantedScopes,
          onFusionWeights: policy.sink,
          onCoverage: coverage.sink,
          ...(asOf !== undefined ? { asOf, since } : {}),
        }),
        () => retrieval.embedAll(input.query, input.query),
        cacheContextFor(deps, ctx, v.id, input.query),
      );
      deps.retrievalLog?.({
        queryText: input.query,
        surfaceType: "knowledge_search",
        sessionId: ctx.sessionId ?? null,
        caller: ctx.caller ?? null,
        hits: retrievalHits(results),
        // The lexical class returned early above, so this path always fused.
        policy: policy.record("static"),
      });
      return {
        vault: v.id,
        mode_used: "graph",
        // THE-631: present only when graphSearch actually ran (absent on a cache HIT).
        ...(coverage.get() ? { coverage: coverage.get() } : {}),
        results,
      };
    },
  });
}
