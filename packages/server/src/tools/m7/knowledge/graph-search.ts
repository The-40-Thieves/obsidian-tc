// WP2.3: the `vault_graph_search` tool factory, extracted verbatim out of buildKnowledgeTools.
// Takes the shared retrieval runtime constructed once in buildKnowledgeTools rather than building
// its own embedder, cache, or policy state — see RetrievalRuntime's doc comment in
// retrieval-runtime.ts. Uses retrieval.embedAll on both the cached and fan-out (THE-448) paths.
//
// THE-630: federated multi-vault search. `vaults` is an ADDITIVE optional field alongside the
// existing required `vault` — same convention as THE-448's `queries[]` alongside `query`: the
// primary `vault` always leads, `vaults` supplies additional targets, and a set that collapses to
// just the primary vault (absent, empty, or every entry equal to `vault`) is an EXACT no-op that
// runs the single-vault path below byte-identically to before this ticket (AC1). See
// `search/federated_search.ts` for the fan-out/fusion engine and its header for why fusion is
// rank-based RRF keyed on (vault, path).
//
// SECURITY: three invariants, each with its own dedicated test (see
// test/federated-search-security.test.ts):
//   1. ACL is enforced PER VAULT. Every federated leg resolves its OWN FolderAcl from
//      `deps.aclByVault` (falling back to `deps.acl`, the root ACL — the SAME fallback
//      governance.ts's own aclResolver and acl.ts's makeIndexReadable already use), and NEVER reads
//      `ctx.acl` — `ctx.acl` is set once, by central dispatch's THE-295 swap, for the single vault
//      named in this tool's declared `vaultArg` field, so it can describe at most one of N
//      federated vaults correctly.
//   2. The query cache stays a per-vault isolation boundary. Each leg's `QueryCacheContext` is
//      built by `cacheContextFor(..., acl)` with that SAME per-vault ACL passed explicitly (not the
//      ctx.acl default), so `aclFingerprint` — "the only thing that keeps caller A's cached results
//      from reaching caller B" (query_cache.ts) — is fingerprinted per vault. No new cache-key
//      shape or combined-fingerprint entry is introduced: each leg goes through the existing,
//      unmodified `cachedGraphSearch`, so a federated call reads/writes N independent per-vault
//      cache entries, never one.
//   3. A vaultBound (HTTP-token) caller is refused BEFORE any DB/embedding work, on the PRESENCE of
//      a non-empty `vaults` field alone — regardless of content, including `vaults: [ctx.vaultId]`
//      naming only its own vault. Central dispatch's `enforceVaultBinding` (mcp/registry/
//      input-binding.ts) cannot catch this by construction: it only inspects the tool's declared
//      singular `vaultArg` field ("vault"), and never looks at `vaults` at all. Relying on it here
//      would ship the exact cross-tenant leak class THE-563/564 were filed to close, on a brand-new
//      surface — so the refusal is the FIRST line of this handler, not delegated to dispatch.
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
 * Run ONE vault's full search — the class-router short-circuit, then either the THE-448 fan-out
 * (multiQueryGraphSearch, bypasses the cache exactly as it always has) or the cached single-query
 * path (cachedGraphSearch). Moved verbatim out of the handler below so the exact same logic backs
 * both the ordinary single-vault call and each leg of a federated one — the single-vault call site
 * is what makes AC1's byte-identical guarantee mechanical rather than a promise to keep two copies
 * in sync.
 */
async function searchOneVault(
  deps: M7Deps,
  retrieval: RetrievalRuntime,
  ctx: CallerContext,
  vaultId: string,
  acl: FolderAcl | undefined,
  query: { text: string; finalTopK: number },
  denseText: string,
  variants: string[],
  cache: QueryCacheContext | undefined,
): Promise<VaultLegResult> {
  const route = deps.classRouter
    ? routeQuery(ctx.db, vaultId, query.text, {
        isReadable: (p) => readableRel(acl, p),
        // THE-694: the rare-term probe is only issued for callers who can read everything.
        readUnrestricted: readEnumerationUnrestricted(acl),
      })
    : { class: "standard" as const, signals: [] as string[] };
  const policy = capturePolicy(deps, vaultId, route.class);
  const coverage = captureCoverage();
  if (route.class === "lexical") {
    const results = lexicalRouteResults(ctx.db, vaultId, query.text, query.finalTopK, (rel) =>
      readableRel(acl, rel),
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
    onFusionWeights: policy.sink,
    onCoverage: coverage.sink,
  });
  const fanOut = variants.length > 1;
  let results: GraphSearchResult[];
  if (fanOut) {
    // The fan-out varies query TEXT, never the embedding: every variant runs against the same
    // vectors (multi_query.ts's module header explains why, and why that still changes the
    // per-variant ranking). So embed once, here, rather than per variant.
    //
    // This path deliberately bypasses THE-497's query cache: multiQueryGraphSearch calls
    // graphSearch directly, so a fan-out neither reads nor populates it.
    const vectors = await retrieval.embedAll(denseText, query.text);
    const fanOutOptions = { ...searchOptions, ...vectors };
    results = await multiQueryGraphSearch(ctx.db, fanOutOptions, variants);
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
  return { mode_used: "graph", results, coverage: coverage.get() };
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
        // THE-630: agent-supplied ADDITIONAL target vaults, federated alongside the primary
        // `vault`. Same "always leads, additive, capped, opt-in" shape as `queries[]` above —
        // see this file's header for the security invariants this field's presence gates.
        //
        // Capped at 8 for the same reason `queries[]` is: cost is LINEAR in target vaults, so an
        // unbounded array is a denial-of-service shape. A `vaults` set that collapses to just the
        // primary vault (absent, empty, or every entry equal to `vault`) is an EXACT no-op —
        // AC1 — running byte-identically to this tool before THE-630.
        vaults: z.array(VaultId).max(8).optional(),
        final_top_k: z.number().int().positive().max(100).default(30),
      })
      .strict(),
    outputSchema: VaultGraphSearchOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "search"],
    handler: async (input, ctx) => {
      // THE-630 AC2 / invariant 3: refuse a vault-bound (HTTP-token) caller BEFORE any DB/embedding
      // work, on PRESENCE of a non-empty `vaults` field alone — never on its content. Central
      // dispatch's enforceVaultBinding only inspects this tool's declared singular `vaultArg`
      // field ("vault") and cannot see `vaults` at all (see this file's header), so this check
      // cannot be delegated to it. `vaults: [ctx.vaultId]` — naming only the caller's own vault —
      // is refused too: the point is that a bound caller must never exercise the federation code
      // path, not that its result would happen to be safe this time.
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
          { text: input.query, finalTopK: input.final_top_k },
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
            { text: input.query, finalTopK: perVaultTopK },
            denseText,
            variants,
            cache,
          );
          return { results: leg.results, meta: leg };
        },
      }));

      const { legOutcomes, fused } = await federatedGraphSearch(legs, input.final_top_k, {
        rrfK: FEDERATED_RRF_K,
      });

      // Top-level `vault`/`mode_used`/`route`/`coverage` keep describing the PRIMARY vault only —
      // unchanged in meaning from before this ticket. `per_vault` is the full per-leg breakdown;
      // a leg that threw (federatedGraphSearch swallows the error) has no meta and is simply
      // omitted from `per_vault` rather than reported as a fabricated mode.
      const primaryMeta = legOutcomes.find((o) => o.vaultId === v.id)?.meta;
      const perVault: Record<
        string,
        { mode_used: "lexical-route" | "graph"; coverage?: CoverageEstimate }
      > = {};
      for (const o of legOutcomes) {
        if (!o.meta) continue;
        perVault[o.vaultId] = {
          mode_used: o.meta.mode_used,
          ...(o.meta.coverage ? { coverage: o.meta.coverage } : {}),
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
        per_vault: perVault,
        results: fused,
      };
    },
  });
}
