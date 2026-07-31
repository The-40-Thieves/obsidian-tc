// M7 — the knowledge domain (THE-233 integration). Exposes the folded retrieval-intelligence
// as MCP tools now that vault_edges (W-SCHEMA, populated by W-INGEST) and the gateway seams are
// on the branch: vault_graph_search (W-RETRIEVAL GraphRAG) and knowledge_challenge (W-WORKERS
// red-team core). Both degrade gracefully when the inference gateway is unconfigured.
// knowledge_get_critical is intentionally absent (vendor-KB data model not in the tree).
//
// WP2 slice 1: this file is now a compatibility facade over ./knowledge/*. The 11 output schema
// consts live in knowledge/schemas.ts, M7Deps in knowledge/deps.ts, and the shared retrieval
// helpers (cache-key/policy/coverage capture, budget packing, the graphSearch options builder,
// the tag/contradiction lookups) in knowledge/retrieval-runtime.ts. Every name this file
// exported before that split (M7Deps, packBudget, buildGraphSearchOptions, noteTagsByPath,
// openContradictionsForPaths, buildKnowledgeTools) is still exported from here, so no consumer
// needs to change its import path.
//
// WP2 slice 2: the two largest tool factories — vault_context (~348 lines) and reflect
// (~167 lines) — now live in knowledge/vault-context.ts and knowledge/reflect.ts as
// createVaultContextTool(deps, retrieval) / createReflectTool(deps, retrieval). The remaining
// five tools (vault_graph_search, knowledge_search, knowledge_get_critical, knowledge_challenge,
// list_contradictions) stay inline here, in their original order, for slice 3. `buildKnowledgeTools`
// still constructs the shared retrieval state (the embedQuery/embedQuerySparse/embedQueryColbert/
// embedAll closures) exactly once, bundles it into a `RetrievalRuntime` object, and hands that same
// object to both factories — neither factory builds its own embedder, cache, or policy state.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { tableExists } from "../../db/introspect";
import type { ToolDefinition } from "../../mcp/registry";
import { challengeProposal, isDecisionChunk } from "../../plane/challenge";
import type { GraphSearchResult } from "../../search/graph_search";
import { multiQueryGraphSearch } from "../../search/multi_query";
import { cachedGraphSearch, type QueryVectors } from "../../search/query_cache";
import { lexicalRouteResults, routeQuery } from "../../search/router";
import { semanticSearch } from "../../search/semantic";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M7Deps } from "./knowledge/deps";
import { createReflectTool } from "./knowledge/reflect";
import {
  buildGraphSearchOptions,
  CHALLENGE_RECALL,
  cacheContextFor,
  captureCoverage,
  capturePolicy,
  noteTagsByPath,
  openContradictionsForPaths,
  packBudget,
  type RetrievalRuntime,
  retrievalHits,
} from "./knowledge/retrieval-runtime";
import {
  KnowledgeChallengeOutput,
  KnowledgeCriticalOutput,
  KnowledgeSearchOutput,
  ListContradictionsOutput,
  VaultGraphSearchOutput,
} from "./knowledge/schemas";
import { createVaultContextTool } from "./knowledge/vault-context";
import { resolveQueryColbert, resolveQuerySparse } from "./query-sparse";

export type { M7Deps };
export { buildGraphSearchOptions, noteTagsByPath, openContradictionsForPaths, packBudget };

export function buildKnowledgeTools(deps: M7Deps): ToolDefinition[] {
  const embedQuery = async (q: string): Promise<number[]> => {
    const [vec] = await deps.embeddingProvider.embed([q], { input: "query" });
    return vec ?? [];
  };
  const embedQuerySparse = (q: string) =>
    resolveQuerySparse(deps.embeddingProvider, q, deps.retrieval?.sparse);
  const embedQueryColbert = (q: string) =>
    resolveQueryColbert(deps.embeddingProvider, q, deps.retrieval?.colbert);
  /**
   * THE-497: the three query encodings as one bundle, invoked ONLY on a cache miss — which is why
   * every retrieval site below passes this as a thunk rather than awaiting it first. `denseText`
   * and `lexicalText` are the same string everywhere except the THE-451 HyDE path, where the dense
   * arm embeds the hypothetical answer and the lexical/late-interaction arms must not.
   *
   * Absent heads are OMITTED rather than set to undefined: graphSearch distinguishes "unset" from
   * "set to undefined" nowhere, but the cache key does — an explicit undefined would be dropped by
   * the canonicaliser anyway, and omitting keeps the two representations identical by construction.
   */
  const embedAll = async (denseText: string, lexicalText: string): Promise<QueryVectors> => {
    const queryVec = await embedQuery(denseText);
    const querySparse = await embedQuerySparse(lexicalText);
    const queryColbert = await embedQueryColbert(lexicalText);
    return {
      queryVec,
      ...(querySparse ? { querySparse } : {}),
      ...(queryColbert ? { queryColbert } : {}),
    };
  };
  // WP2.2: the single shared retrieval-runtime object, constructed exactly once here and handed to
  // both extracted tool factories below. Neither factory builds its own embedder, cache, or policy
  // state — they compose entirely on this object, so a cache hit (which never calls embedAll) stays
  // a cache hit no matter which factory reached it through.
  const retrieval: RetrievalRuntime = { embedQuery, embedQuerySparse, embedQueryColbert, embedAll };

  return [
    createVaultContextTool(deps, retrieval),
    createReflectTool(deps, retrieval),
    defineTool({
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
          ? routeQuery(ctx.db, v.id, input.query)
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
          const vectors = await embedAll(denseText, input.query);
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
            () => embedAll(denseText, input.query),
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
    }),

    defineTool({
      name: "knowledge_search",
      domain: "docs",
      description:
        "Semantic + keyword search over a vendor / external-docs corpus (a reserved read-only docs vault), with wikilink graph expansion and RRF fusion. The docs-scoped analogue of vault_graph_search: bind `vault` to the docs corpus id. Returns source-attributed chunks tagged seed|expansion. Gated on read:docs so it stays isolated from the private vault.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1),
          final_top_k: z.number().int().positive().max(100).default(20),
        })
        .strict(),
      outputSchema: KnowledgeSearchOutput,
      requiredScopes: ["read:docs"],
      tags: ["docs", "search", "knowledge"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        // P1.5: the read:docs surface is code-bound to a docs-kind vault, so a misprovisioned
        // docs token cannot read the private vault even if it names its id.
        if (v.kind !== "docs")
          throw err.forbidden("knowledge_search operates only on a docs-kind vault", {
            vault: v.id,
            kind: v.kind,
          });
        const route = deps.classRouter
          ? routeQuery(ctx.db, v.id, input.query)
          : { class: "standard" as const, signals: [] as string[] };
        const policy = capturePolicy(deps, v.id, route.class);
        const coverage = captureCoverage();
        if (route.class === "lexical") {
          const results = lexicalRouteResults(ctx.db, v.id, input.query, input.final_top_k, (rel) =>
            readableRel(ctx.acl, rel),
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
            onFusionWeights: policy.sink,
            onCoverage: coverage.sink,
          }),
          () => embedAll(input.query, input.query),
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
    }),

    defineTool({
      name: "knowledge_get_critical",
      domain: "docs",
      description:
        "List the critical-severity docs in a vendor / external-docs corpus: the breaking changes, security issues, and production gotchas to read before starting work. A tight metadata pre-filter over frontmatter severity == 'critical', not a search. Optionally narrow by `source` (the vendor or tool the doc is about). Gated on read:docs so it stays isolated from the private vault.",
      inputSchema: z
        .object({
          vault: VaultId,
          source: z.string().min(1).optional(),
          limit: z.number().int().positive().max(200).default(100),
        })
        .strict(),
      outputSchema: KnowledgeCriticalOutput,
      requiredScopes: ["read:docs"],
      tags: ["docs", "knowledge"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        // P1.5: same docs-kind binding as knowledge_search — this reader is never allowed to
        // resolve a private/system vault.
        if (v.kind !== "docs")
          throw err.forbidden("knowledge_get_critical operates only on a docs-kind vault", {
            vault: v.id,
            kind: v.kind,
          });
        const rows = ctx.db
          .prepare(
            "SELECT path, title, frontmatter FROM notes WHERE vault_id = ? AND json_extract(frontmatter, '$.severity') = 'critical' ORDER BY path",
          )
          .all(v.id) as Array<{ path: string; title: string; frontmatter: string | null }>;
        const items = rows
          .filter((r) => readableRel(ctx.acl, r.path))
          .map((r) => {
            let fm: Record<string, unknown> = {};
            if (r.frontmatter) {
              try {
                fm = JSON.parse(r.frontmatter) as Record<string, unknown>;
              } catch {
                fm = {};
              }
            }
            return {
              path: r.path,
              title: r.title,
              category: typeof fm.category === "string" ? fm.category : null,
              source: typeof fm.source === "string" ? fm.source : null,
              severity: "critical" as const,
            };
          })
          .filter((it) => input.source === undefined || it.source === input.source)
          .sort(
            (a, b) =>
              (a.source ?? "").localeCompare(b.source ?? "") ||
              (a.category ?? "").localeCompare(b.category ?? "") ||
              a.path.localeCompare(b.path),
          )
          .slice(0, input.limit);
        return { vault: v.id, count: items.length, items };
      },
    }),

    defineTool({
      name: "knowledge_challenge",
      domain: "knowledge",
      description:
        "Red-team a proposal against your documented decision history. Retrieves decision-bearing chunks (02-projects, 04-writing/Published, 09-reference/system-reviews, 09-reference/syntheses) and asks the inference gateway to flag DIRECT_CONTRADICTION / PATTERN_REPEAT / REVERSAL / HIDDEN_DEPENDENCY. Requires the gateway; reports unavailable when it is not configured.",
      inputSchema: z
        .object({
          vault: VaultId,
          proposal: z.string().min(10).max(4000),
        })
        .strict(),
      outputSchema: KnowledgeChallengeOutput,
      requiredScopes: ["read:notes"],
      tags: ["knowledge"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        if (!deps.roles) {
          return {
            vault: v.id,
            available: false,
            message: "inference gateway not configured (set OBSIDIAN_TC_GATEWAY_URL)",
          };
        }
        const queryVec = await embedQuery(input.proposal);
        const hits = semanticSearch(ctx.db, v.id, queryVec, {
          k: CHALLENGE_RECALL,
          returnContent: true,
          isReadable: (rel) => readableRel(ctx.acl, rel),
          model: deps.embeddingProvider.id, // THE-530: constrain to the active model
        });
        // THE-230: challenge recall is a real retrieval surface — log it like the search tools.
        deps.retrievalLog?.({
          queryText: input.proposal,
          surfaceType: "knowledge_challenge",
          sessionId: ctx.sessionId ?? null,
          caller: ctx.caller ?? null,
          hits: hits.map((h, i) => ({ chunkId: h.chunk_id, rank: i + 1, score: h.score })),
          // THE-538: challenge recall is a bare dense scan (semanticSearch), not a fusion — there
          // is no stream to attribute a hit to and no lexical/sparse weight to record. Saying so
          // explicitly is the point: a NULL here must read as "this policy has no such weight",
          // never as "we forgot to log it".
          policy: {
            vaultId: v.id,
            policyId: "dense-only",
            denseW: 1,
            lexW: null,
            sparseW: null,
            fusionMode: null,
            rrfK: null,
            routeClass: null,
          },
        });
        // Enrich with note-level tags so isDecisionChunk's tag rule fires (not just the path
        // prefix) and the judge sees the tags; the semantic hit itself carries no tags (THE-309).
        const tagsByPath = noteTagsByPath(ctx.db, v.id, [...new Set(hits.map((h) => h.path))]);
        const evidence = hits
          .map((h) => ({
            path: h.path,
            content: h.content ?? "",
            tags: tagsByPath.get(h.path) ?? [],
          }))
          .filter((e) => isDecisionChunk({ path: e.path, tags: e.tags }));
        if (evidence.length === 0) {
          return {
            vault: v.id,
            available: true,
            evidence_count: 0,
            output: null,
            message: "no decision-bearing chunks matched this proposal",
          };
        }
        // Open contradictions touching the evidence give the judge cross-note conflict context.
        const contradictions = openContradictionsForPaths(
          ctx.db,
          v.id,
          evidence.map((e) => e.path),
          (rel) => readableRel(ctx.acl, rel),
        );
        const { output, model } = await challengeProposal(
          deps.roles,
          input.proposal,
          evidence,
          contradictions,
        );
        return {
          vault: v.id,
          available: true,
          evidence_count: evidence.length,
          contradiction_count: contradictions.length,
          output,
          model,
        };
      },
    }),

    // THE-491: contradiction detection is fully wired and writes the `contradictions` table, but
    // results only ever surfaced indirectly — folded inside vault_context / reflect /
    // knowledge_challenge via openContradictionsForPaths above. This is the direct reader: same
    // plumbing, no composition, so an agent (or a human) can inspect flagged conflicts on a note
    // set standalone rather than paying for a full context/challenge call to see them.
    defineTool({
      name: "list_contradictions",
      domain: "knowledge",
      description:
        "List open contradictions (judge_verdict: 'contradiction' | 'tension') touching any of the given notes — the same detector output vault_context/reflect/knowledge_challenge surface indirectly, exposed directly for standalone inspection. Read-only.",
      inputSchema: z.object({ vault: VaultId, paths: z.array(VaultPath).min(1).max(200) }).strict(),
      outputSchema: ListContradictionsOutput,
      requiredScopes: ["read:notes"],
      tags: ["knowledge"],
      pathAcl: (input) => input.paths.map((p) => ({ op: "read" as const, path: p })),
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const paths = input.paths.map((p) => normalizeVaultPath(p));
        for (const p of paths) enforcePathAcl(ctx.acl, "read", p, v.root);
        if (!tableExists(ctx.db, "contradictions")) {
          return {
            vault: v.id,
            available: false,
            message: "contradictions table not present (pre-migration cache.db)",
            total: 0,
            contradictions: [],
          };
        }
        const contradictions = openContradictionsForPaths(ctx.db, v.id, paths, (rel) =>
          readableRel(ctx.acl, rel),
        );
        return {
          vault: v.id,
          available: true,
          total: contradictions.length,
          contradictions,
        };
      },
    }),
  ];
}
