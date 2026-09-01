// WP2.3: vault_graph_search tool factory. Runs against the shared RetrievalRuntime built once in
// buildKnowledgeTools (embedder/cache/policy state) — see RetrievalRuntime's doc comment in
// retrieval-runtime.ts. THE-630 adds federated multi-vault search: `vaults` is additive alongside
// the required `vault` (primary vault always leads); a set collapsing to just the primary vault
// is an exact no-op (AC1), byte-identical to this tool before THE-630. See federated_search.ts
// for the fan-out/fusion engine (RRF keyed on (vault, path)). See docs/design/graph-search.md.
//
// SECURITY: three invariants, each with a dedicated test (test/federated-search-security.test.ts):
//   1. ACL is resolved PER VAULT, from deps.aclByVault (falling back to deps.acl), never from
//      ctx.acl — ctx.acl describes only the single vault named in this tool's declared vaultArg.
//   2. The query cache is a per-vault isolation boundary: each leg's QueryCacheContext carries
//      that leg's own ACL, so aclFingerprint never lets one caller's cached results reach another.
//   3. A vaultBound (HTTP-token) caller is refused on the PRESENCE of a non-empty `vaults` field
//      alone, before any DB/embedding work — central dispatch cannot catch this by construction
//      (it only inspects the declared singular `vaultArg`). See docs/design/graph-search.md.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { FolderAcl } from "../../../acl";
import type { CallerContext, ToolDefinition } from "../../../mcp/registry";
import { type FederatedLeg, federatedGraphSearch } from "../../../search/federated_search";
import type { GraphSearchResult } from "../../../search/graph_search";
import type { CoverageEstimate } from "../../../search/graph_search_stages/types";
import { multiQueryGraphSearch } from "../../../search/multi_query";
import { cachedGraphSearch, type QueryCacheContext } from "../../../search/query_cache";
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
import { VaultGraphSearchOutput } from "./schemas";

/** One vault leg's outcome, independent of how federated or not the call turns out to be — the
 *  single-vault path below builds exactly one of these and unwraps it; the federated path builds
 *  one per target vault and hands them to federatedGraphSearch. */
interface VaultLegResult {
  mode_used: "lexical-route" | "graph";
  route?: string[];
  coverage?: CoverageEstimate;
  results: GraphSearchResult[];
  // THE-926: set only on the fan-out path (variants.length > 1), and only when at least one
  // variant's graphSearch call threw a swallowed (genuinely transient) error — see
  // search/multi_query.ts's OnVariantOutcome. Absent, never 0, otherwise.
  failedVariants?: number;
}

/** THE-630: resolve a target vault's ACL the same way governance.ts's own `aclResolver` and
 *  acl.ts's `makeIndexReadable` already do — a vault with no per-vault override falls back to the
 *  ROOT acl, never to "no ACL at all" (which would be unrestricted, strictly MORE permissive than
 *  today's single-vault behavior for that same vault). Both `deps.acl`/`deps.aclByVault` absent
 *  (a deployment that never wires them) resolves to `undefined`, matching `ctx.acl`'s own
 *  "absent -> unrestricted" convention rather than inventing a new one. */
function aclForVault(deps: M7Deps, vaultId: string): FolderAcl | undefined {
  return deps.aclByVault?.get(vaultId) ?? deps.acl;
}

/**
 * Runs ONE vault's full search: the class-router short-circuit, then either the THE-448 fan-out
 * (multiQueryGraphSearch, bypasses the cache) or the cached single-query path (cachedGraphSearch).
 * Shared verbatim by the single-vault call site and every federated leg, so AC1's byte-identical
 * guarantee holds mechanically rather than by keeping two copies in sync.
 */
async function searchOneVault(
  deps: M7Deps,
  retrieval: RetrievalRuntime,
  ctx: CallerContext,
  vaultId: string,
  acl: FolderAcl | undefined,
  query: { text: string; finalTopK: number; asOf?: number; since?: number },
  denseText: string,
  variants: string[],
  cache: QueryCacheContext | undefined,
): Promise<VaultLegResult> {
  let route = deps.classRouter
    ? routeQuery(ctx.db, vaultId, query.text, {
        isReadable: (p) => readableRel(acl, p),
        // THE-694: the rare-term probe is only issued for callers who can read everything.
        readUnrestricted: readEnumerationUnrestricted(acl),
      })
    : { class: "standard" as const, signals: [] as string[] };
  // THE-635: the lexical short-circuit below bypasses candidateAssembly entirely, which is where
  // the point-in-time PRE-filter lives — an as_of query must never take that route, or a chunk
  // that did not exist at D would leak through unfiltered. Force the graph/fusion path instead;
  // classRouter is dark by default so this branch is inert on most deployments.
  if (query.asOf !== undefined && route.class === "lexical") {
    route = { class: "standard", signals: route.signals };
  }
  const policy = capturePolicy(deps, vaultId, route.class);
  const coverage = captureCoverage();
  if (route.class === "lexical") {
    // THE-853: resolve THIS LEG's own ACL partition (never ctx.acl — see this file's header,
    // invariant 1) so the lexical-route bm25Chunks call takes the exact JOIN path (or fails
    // closed) instead of the leaky over-fetch fallback.
    const walkFilter = resolveAclWalkFilter(ctx.db, vaultId, acl, ctx.grantedScopes, (rel) =>
      readableRel(acl, rel),
    );
    const results = lexicalRouteResults(
      ctx.db,
      vaultId,
      query.text,
      query.finalTopK,
      (rel) => readableRel(acl, rel),
      walkFilter.aclSetId,
      walkFilter.aclWalkFilter?.blocked,
    );
    deps.retrievalLog?.({
      queryText: query.text,
      surfaceType: "vault_graph_search",
      sessionId: ctx.sessionId ?? null,
      caller: ctx.caller ?? null,
      hits: retrievalHits(results),
      policy: policy.record("lexical-route"),
    });
    return { mode_used: "lexical-route", route: route.signals, results };
  }
  const searchOptions = buildGraphSearchOptions(deps, {
    route,
    query: query.text,
    vaultId,
    finalTopK: query.finalTopK,
    reranker: deps.reranker,
    isReadable: (rel) => readableRel(acl, rel),
    // THE-852: this leg's OWN per-vault acl, never ctx.acl — same rule cacheContextFor already
    // follows (see this file's header, invariant 1/2).
    db: ctx.db,
    acl,
    grantedScopes: ctx.grantedScopes,
    onFusionWeights: policy.sink,
    onCoverage: coverage.sink,
    ...(query.asOf !== undefined ? { asOf: query.asOf, since: query.since } : {}),
  });
  const fanOut = variants.length > 1;
  let results: GraphSearchResult[];
  let failedVariants = 0;
  if (fanOut) {
    // The fan-out varies query TEXT, never the embedding: every variant runs against the same
    // vectors (multi_query.ts's module header explains why, and why that still changes the
    // per-variant ranking). So embed once, here, rather than per variant.
    //
    // This path deliberately bypasses THE-497's query cache: multiQueryGraphSearch calls
    // graphSearch directly, so a fan-out neither reads nor populates it.
    const vectors = await retrieval.embedAll(denseText, query.text);
    const fanOutOptions = { ...searchOptions, ...vectors };
    // THE-926: the smallest honest signal that a variant's own graphSearch call swallowed a
    // transient error rather than genuinely finding nothing — a deliberate/structural refusal
    // (isLoudRefusal) is never swallowed at all; it propagates out of this call instead.
    results = await multiQueryGraphSearch(ctx.db, fanOutOptions, variants, (event) => {
      if (event.outcome === "swallowed_error") failedVariants += 1;
    });
  } else {
    results = await cachedGraphSearch(
      ctx.db,
      searchOptions,
      () => retrieval.embedAll(denseText, query.text),
      cache,
    );
  }
  deps.retrievalLog?.({
    queryText: query.text,
    surfaceType: "vault_graph_search",
    sessionId: ctx.sessionId ?? null,
    caller: ctx.caller ?? null,
    hits: retrievalHits(results),
    // The lexical class returned early above, so this path always fused.
    policy: policy.record("static"),
  });
  return {
    mode_used: "graph",
    results,
    coverage: coverage.get(),
    ...(fanOut && failedVariants > 0 ? { failedVariants } : {}),
  };
}

// THE-630 fan-out convention (same rrfK default as THE-448's fuseVariants, kept local so this
// tool's cross-vault fusion does not silently drift from graph_search's own in-query rrfK default
// without a deliberate override).
const FEDERATED_RRF_K = 10;

export function createGraphSearchTool(deps: M7Deps, retrieval: RetrievalRuntime): ToolDefinition {
  return defineTool({
    name: "vault_graph_search",
    domain: "knowledge",
    description:
      "Cross-domain / multi-hop semantic search with wikilink graph expansion (GraphRAG). Seeds by vector similarity, expands through the links_to graph (vault_edges), and fuses by RRF. Run index_vault first so the edge graph is populated. Returns chunks tagged seed|expansion with hop + via_edge. Optional `vaults[]` federates the same query across additional vaults (max 8), fusing per-vault ranked lists by RRF; each result is tagged with its source vault.",
    inputSchema: z
      .object({
        vault: VaultId,
        query: z.string().min(1),
        // THE-451: agent-supplied HyDE (Gao 2023), MCP-native — the client writes the hypothetical
        // answer, no server-side LLM involved. Replaces the query as the DENSE-arm seed only;
        // sparse/ColBERT always embed the raw query. No min() bound: blank/absent is a silent
        // no-op, length-gated in the handler, not a validation error. Opt-in lever for vague
        // queries — never the default path. See docs/design/graph-search.md.
        hypothetical_answer: z.string().max(4000).optional().nullable(),
        // THE-448: agent-supplied phrasing VARIANTS, MCP-native — the client writes the
        // paraphrases, no server LLM. Each variant runs its own full graphSearch, fused by
        // rank-based RRF (see search/multi_query.ts). `query` is always included as a variant so
        // paraphrases-only input can't drop it. Capped at 8 (cost is linear — N phrasings is N
        // searches); blanks dropped, duplicates collapsed to an exact no-op. Opt-in per call.
        // See docs/design/graph-search.md.
        queries: z.array(z.string().max(1000)).max(8).optional(),
        // THE-630: agent-supplied ADDITIONAL target vaults, federated alongside the primary
        // `vault` — same additive/capped/opt-in shape as `queries[]` above. Capped at 8 (cost is
        // linear in target vaults). A set collapsing to just the primary vault (absent, empty, or
        // all equal to `vault`) is an exact no-op (AC1), byte-identical to this tool before
        // THE-630. See this file's header for the security invariants this field's presence gates.
        vaults: z.array(VaultId).max(8).optional(),
        final_top_k: z.number().int().positive().max(100).default(30),
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
    outputSchema: VaultGraphSearchOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "search"],
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
      // THE-630 AC2 / invariant 3: refuse a vault-bound caller BEFORE any DB/embedding work, on
      // the PRESENCE of a non-empty `vaults` field alone — never on its content (`vaults:
      // [ctx.vaultId]` is refused too). Central dispatch's enforceVaultBinding only inspects the
      // declared singular `vaultArg`, and cannot see `vaults` at all (see this file's header), so
      // this check cannot be delegated to it — a bound caller must never exercise the federation
      // path.
      if (ctx.vaultBound === true && input.vaults && input.vaults.length > 0) {
        throw err.forbidden(
          "federated multi-vault search is not available to a vault-bound caller",
          { vaults: input.vaults, bound_vault: ctx.vaultId },
        );
      }

      const v = deps.vaultRegistry.resolve(input.vault);
      // THE-451: trim-and-check so null/absent/blank are all byte-identical to no HyDE.
      const hyde = input.hypothetical_answer?.trim();
      const hydeActive = !!hyde;
      // THE-451: the dense arm embeds the hypothetical answer when supplied; sparse/ColBERT
      // ALWAYS embed the raw query — HyDE seeds the dense vector only, it must never
      // contaminate lexical or late-interaction matching.
      const denseText = hydeActive ? (hyde as string) : input.query;
      // THE-448: the main query ALWAYS leads, then the supplied phrasings, blanks dropped and
      // duplicates collapsed — a repeat must not double-weight itself in the cross-variant RRF.
      const variants = [
        ...new Set([input.query, ...(input.queries ?? [])].map((q) => q.trim())),
      ].filter((q) => q.length > 0);
      const fanOut = variants.length > 1;

      // THE-630: same convention as `queries[]` above — the primary vault always leads, `vaults`
      // appends additional distinct targets. AC3: every requested vault is validated (via
      // vaultRegistry.resolve, which throws vault_not_found naming the offending id) BEFORE any
      // search runs — a clean error, never a silently-skipped fan-out leg.
      const extraVaultIds = [...new Set(input.vaults ?? [])].filter((id) => id !== v.id);
      for (const id of extraVaultIds) deps.vaultRegistry.resolve(id);
      const targetVaultIds = [v.id, ...extraVaultIds];
      const federated = targetVaultIds.length > 1;

      if (!federated) {
        // AC1: byte-identical to this tool before THE-630 — same helper, same acl (ctx.acl, via
        // cacheContextFor's default), same cache context, same response assembly.
        const leg = await searchOneVault(
          deps,
          retrieval,
          ctx,
          v.id,
          ctx.acl,
          { text: input.query, finalTopK: input.final_top_k, asOf, since },
          denseText,
          variants,
          cacheContextFor(deps, ctx, v.id, denseText),
        );
        return {
          vault: v.id,
          mode_used: leg.mode_used,
          ...(leg.route ? { route: leg.route } : {}),
          ...(hydeActive ? { query: input.query, hyde: true } : {}),
          ...(fanOut ? { variants_used: variants.length } : {}),
          ...(leg.failedVariants ? { failed_variants: leg.failedVariants } : {}),
          ...(leg.coverage ? { coverage: leg.coverage } : {}),
          results: leg.results,
        };
      }

      // Federated path (2+ distinct target vaults). Over-fetch per vault so cross-vault RRF has
      // depth to work with, mirroring THE-448's multiQueryGraphSearch over-fetch — a vault whose
      // top hit ranks #1 there but is absent from the other vaults must still be visible to RRF
      // after the other vaults' hits interleave ahead of it in the fused order.
      const perVaultTopK = Math.max(input.final_top_k * 2, input.final_top_k + 10);
      const legs: FederatedLeg<VaultLegResult>[] = targetVaultIds.map((vaultId) => ({
        vaultId,
        run: async () => {
          // Invariant 1 (ACL per vault) + invariant 2 (cache isolation per vault): both resolved
          // from the SAME per-vault acl, never from ctx.acl — see this file's header and
          // aclForVault's / cacheContextFor's own doc comments.
          const acl = aclForVault(deps, vaultId);
          const cache = cacheContextFor(deps, ctx, vaultId, denseText, acl);
          const leg = await searchOneVault(
            deps,
            retrieval,
            ctx,
            vaultId,
            acl,
            { text: input.query, finalTopK: perVaultTopK, asOf, since },
            denseText,
            variants,
            cache,
          );
          return { results: leg.results, meta: leg };
        },
      }));

      // THE-926: the smallest honest signal that a whole vault leg swallowed a transient error
      // (isLoudRefusal-class errors are never swallowed — they propagate out of this call instead).
      let failedVaults = 0;
      const { legOutcomes, fused } = await federatedGraphSearch(
        legs,
        input.final_top_k,
        { rrfK: FEDERATED_RRF_K },
        (event) => {
          if (event.outcome === "swallowed_error") failedVaults += 1;
        },
      );

      // Top-level `vault`/`mode_used`/`route`/`coverage` keep describing the PRIMARY vault only —
      // unchanged in meaning from before this ticket. `per_vault` is the full per-leg breakdown;
      // a leg that threw (federatedGraphSearch swallows the error) has no meta and is simply
      // omitted from `per_vault` rather than reported as a fabricated mode.
      const primaryMeta = legOutcomes.find((o) => o.vaultId === v.id)?.meta;
      const perVault: Record<
        string,
        {
          mode_used: "lexical-route" | "graph";
          coverage?: CoverageEstimate;
          failed_variants?: number;
        }
      > = {};
      for (const o of legOutcomes) {
        if (!o.meta) continue;
        perVault[o.vaultId] = {
          mode_used: o.meta.mode_used,
          ...(o.meta.coverage ? { coverage: o.meta.coverage } : {}),
          ...(o.meta.failedVariants ? { failed_variants: o.meta.failedVariants } : {}),
        };
      }

      return {
        vault: v.id,
        mode_used: primaryMeta?.mode_used ?? "graph",
        ...(primaryMeta?.route ? { route: primaryMeta.route } : {}),
        ...(hydeActive ? { query: input.query, hyde: true } : {}),
        ...(fanOut ? { variants_used: variants.length } : {}),
        ...(primaryMeta?.coverage ? { coverage: primaryMeta.coverage } : {}),
        vaults_used: targetVaultIds.length,
        ...(failedVaults > 0 ? { failed_vaults: failedVaults } : {}),
        per_vault: perVault,
        results: fused,
      };
    },
  });
}
