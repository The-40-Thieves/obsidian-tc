// work_search — split out of experiential-tools.ts (THE-642 pushed it past biome's 700-line
// ceiling; see that file's header). Own module rather than growing the old one further, and
// imports the shared row/projection shape from episode-projection.ts (a THIRD module) rather than
// from experiential-tools.ts, so the two tool files never import each other — see
// episode-projection.ts's header for why that avoids a circular import.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { fuseEpisodeRanks, semanticRankEpisodes } from "../../experiential/episode-search";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import {
  EpisodeProjection,
  type EpisodeRow,
  projectEpisode,
  TimeFilters,
  visiblePrevIds,
} from "./episode-projection";
import {
  availableWith,
  CROSS_PRINCIPAL_SCOPE,
  canCrossPrincipal,
  type M8Deps,
  UNAVAILABLE,
} from "./shared";

export function buildWorkSearchTool(deps: M8Deps): ToolDefinition[] {
  const now = () => (deps.now ?? Date.now)();

  return [
    defineTool({
      name: "work_search",
      domain: "knowledge",
      description:
        "Search the experiential work-memory (agent_episodes) — what the agent actually did. MEMORY semantics with the THE-238 reader contract enforced: only evaluator-approved (eligible) episodes by default, tombstoned/expired rows never surface, results are partitioned to the calling principal, and a trust floor (default 0.3) excludes high-risk content. include_pending opts into not-yet-evaluated episodes (still trust-floored); any_caller crosses the agent partition and requires the admin:workspace scope (P1.7: the partition is an authorization boundary, not a free filter). `semantic` (THE-642, opt-in) fuses a cosine-similarity channel over `summary` alongside the lexical match via Reciprocal Rank Fusion, so a paraphrased query can find an episode the lexical LIKE match misses — lexical stays the exact-match failsafe for names/dates/ids, and the SAME reader-contract filters above apply to both channels identically (the fused pool is never wider than what lexical alone could already see). Degrades silently to lexical-only when no `query`, no embedding provider is configured, or the provider errors.",
      inputSchema: z
        .object({
          query: z.string().min(1).optional(),
          tool: z.string().optional(),
          session_id: z.string().optional(),
          ...TimeFilters,
          k: z.number().int().positive().max(200).default(20),
          min_trust: z.number().min(0).max(1).default(0.3),
          include_pending: z.boolean().default(false),
          any_caller: z.boolean().default(false),
          semantic: z.boolean().default(false),
        })
        .strict(),
      outputSchema: availableWith({
        floor: z.object({
          min_trust: z.number(),
          include_pending: z.boolean(),
          // THE-642: whether the semantic channel actually ran — false whenever `semantic` was
          // requested but there was no query, no provider, or the provider errored, so a caller
          // can tell "hybrid ran" from "silently fell back to lexical-only".
          semantic_used: z.boolean(),
        }),
        results: z.array(EpisodeProjection),
      }),
      requiredScopes: ["read:workspace"],
      tags: ["experiential", "search"],
      handler: async (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        const edb = deps.edb;
        // The FULL THE-238 reader-contract clause set, minus the query text match — shared by
        // every channel below (plain listing, lexical, and the semantic candidate pool) so the
        // partition/eligibility/trust/tombstone/validity boundary is identical across all of them
        // by construction, never a per-channel copy that could drift.
        const baseClauses = ["blocked = 0", "(valid_until IS NULL OR valid_until > ?)"];
        const baseParams: unknown[] = [now()];
        if (input.include_pending) {
          baseClauses.push("eligibility IN ('eligible', 'pending')");
        } else {
          baseClauses.push("eligibility = 'eligible'");
        }
        baseClauses.push("(trust IS NULL OR trust >= ?)");
        baseParams.push(input.min_trust);
        // P1.7: any_caller crosses the agent partition — an authorization boundary, not a free
        // filter. Without the elevated scope it is a forbidden request, not a silent self-scope.
        if (input.any_caller && !canCrossPrincipal(ctx))
          throw err.forbidden(`any_caller requires the ${CROSS_PRINCIPAL_SCOPE} scope`);
        if (!input.any_caller) {
          baseClauses.push("caller IS ?");
          baseParams.push(ctx.caller ?? null);
        }
        if (input.tool) {
          baseClauses.push("tool = ?");
          baseParams.push(input.tool);
        }
        if (input.session_id) {
          baseClauses.push("session_id = ?");
          baseParams.push(input.session_id);
        }
        if (input.since !== undefined) {
          baseClauses.push("ts >= ?");
          baseParams.push(input.since);
        }
        if (input.until !== undefined) {
          baseClauses.push("ts <= ?");
          baseParams.push(input.until);
        }

        const selectCols =
          "id, ts, vault_id, session_id, caller, channel, episode_type, tool, status, " +
          "error_code, duration_ms, result_size, summary, tags, trust, eligibility, " +
          "blocked, prev_id, task_result, verdict_at";
        const selectRows = (clauses: string[], params: unknown[], limit: number): EpisodeRow[] =>
          edb
            .prepare(
              `SELECT ${selectCols} FROM agent_episodes WHERE ${clauses.join(" AND ")}
               ORDER BY ts DESC LIMIT ?`,
            )
            .all(...params, limit) as EpisodeRow[];

        const useHybrid = input.semantic && !!input.query && !!deps.embeddingProvider;
        let rows: EpisodeRow[];
        let semanticUsed = false;

        if (!useHybrid) {
          const clauses = [...baseClauses];
          const params = [...baseParams];
          if (input.query) {
            clauses.push(
              "(tool LIKE '%' || ? || '%' OR summary LIKE '%' || ? || '%' OR tags LIKE '%' || ? || '%' OR args_json LIKE '%' || ? || '%')",
            );
            params.push(input.query, input.query, input.query, input.query);
          }
          rows = selectRows(clauses, params, input.k);
        } else {
          // Over-fetch a bounded pool for BOTH channels — same over-fetch shape multi_query.ts
          // uses for cross-variant RRF (finalTopK*2, floor +10), so a hit that only one stream
          // finds still has depth to survive fusion. The lexical channel below runs the identical
          // LIKE clause work_search always has (same recall as non-hybrid mode, just a wider
          // LIMIT); the semantic channel scores summaries from the SAME reader-contract-filtered
          // pool (baseClauses only, no LIKE) — never a wider candidate set than lexical could see.
          const poolSize = Math.max(input.k * 2, input.k + 10);
          const lexClauses = [
            ...baseClauses,
            "(tool LIKE '%' || ? || '%' OR summary LIKE '%' || ? || '%' OR tags LIKE '%' || ? || '%' OR args_json LIKE '%' || ? || '%')",
          ];
          const lexParams = [...baseParams, input.query, input.query, input.query, input.query];
          const lexRows = selectRows(lexClauses, lexParams, poolSize);
          const poolRows = selectRows(baseClauses, baseParams, poolSize);

          const semanticIds = await semanticRankEpisodes(
            deps.embeddingProvider as NonNullable<typeof deps.embeddingProvider>,
            input.query as string,
            poolRows.map((r) => ({ id: r.id, summary: r.summary })),
          );
          semanticUsed = true;

          const byId = new Map<string, EpisodeRow>();
          for (const r of poolRows) byId.set(r.id, r);
          for (const r of lexRows) byId.set(r.id, r);
          const fusedIds = fuseEpisodeRanks([lexRows.map((r) => r.id), semanticIds]).slice(
            0,
            input.k,
          );
          rows = fusedIds.map((id) => byId.get(id)).filter((r): r is EpisodeRow => r !== undefined);
        }

        const visiblePrev = visiblePrevIds(edb, rows);
        return {
          available: true,
          floor: {
            min_trust: input.min_trust,
            include_pending: input.include_pending,
            semantic_used: semanticUsed,
          },
          results: rows.map((r) => projectEpisode(r, visiblePrev)),
        };
      },
    }),
  ];
}
