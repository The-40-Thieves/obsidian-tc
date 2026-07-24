// M8 — the experiential domain (THE-229). Retrieval + management verbs over the membrane
// store (agent_episodes / chunk_retrievals in experiential.db). Enforces the THE-238 reader
// contract at the retrieval boundary:
//   * blocked (tombstoned) rows NEVER surface in work_search — control 1, absolute;
//   * eligibility gates memory-use: work_search defaults to 'eligible' only (honest-empty
//     until the THE-222 sleep-time evaluator stamps rows), include_pending is an explicit
//     opt-in that still carries the trust floor;
//   * bi-temporal validity: expired rows (valid_until <= now) never surface — control 3;
//   * per-agent partitioning: results default to the CALLING principal's own episodes;
//     any_caller is an explicit cross-partition request — the THE-238 partitioning control;
//   * trust floor (min_trust, default 0.3): the "higher relevance floor than vault_search" —
//     clean dispatch episodes (0.6) clear it, suspect (0.3) sit at the edge, high-risk
//     (0.06) never surface even when pending is included.
// work_episodes is the INSPECTION surface (the first-party list/inspect verb): it shows
// pending/ineligible state for management, hides tombstoned rows unless include_blocked.
// work_forget surfaces the control-1 tombstone as a user verb. record_retrieval_feedback is
// the THE-230 outcome writer: stamps feedback/outcome onto the most recent retrieval
// event(s) for a chunk, feeding the ACT-R recompute.
import { err, grantsAll } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { Database } from "../../db/types";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";

// P1.7 (audit THE-562): the experiential per-principal partition is an AUTHORIZATION boundary, not
// a default filter. Crossing it — reading other principals' episodes (any_caller), forgetting an
// episode you don't own, or stamping feedback across sessions — requires this elevated scope.
const CROSS_PRINCIPAL_SCOPE = "admin:workspace";
const canCrossPrincipal = (ctx: CallerContext): boolean =>
  grantsAll(ctx.grantedScopes, [CROSS_PRINCIPAL_SCOPE]);

export interface M8Deps {
  /** Open experiential.db handle; absent (all capture/config off) -> tools report unavailable. */
  edb?: Database;
  now?: () => number;
}

const UNAVAILABLE = {
  available: false,
  message:
    "experiential store is not open (enable experiential.logRetrievals, captureEpisodes, or activationRerank)",
};

interface EpisodeRow {
  id: string;
  ts: number;
  vault_id: string | null;
  session_id: string | null;
  caller: string | null;
  channel: string;
  episode_type: string;
  tool: string | null;
  status: string;
  error_code: string | null;
  duration_ms: number | null;
  result_size: number | null;
  summary: string | null;
  tags: string | null;
  trust: number | null;
  eligibility: string;
  blocked: number;
  prev_id: string | null;
}

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function projectEpisode(r: EpisodeRow) {
  return {
    id: r.id,
    ts: r.ts,
    vault: r.vault_id,
    session_id: r.session_id,
    caller: r.caller,
    channel: r.channel,
    episode_type: r.episode_type,
    tool: r.tool,
    status: r.status,
    error_code: r.error_code,
    duration_ms: r.duration_ms,
    result_size: r.result_size,
    summary: r.summary,
    tags: parseTags(r.tags),
    // provenance the THE-229 spec requires on every result
    trust: r.trust,
    eligibility: r.eligibility,
    blocked: r.blocked === 1,
  };
}

const TimeFilters = {
  since: z.number().int().positive().optional(),
  until: z.number().int().positive().optional(),
};

export function buildExperientialTools(deps: M8Deps): ToolDefinition[] {
  const now = () => (deps.now ?? Date.now)();

  return [
    defineTool({
      name: "work_search",
      description:
        "Search the experiential work-memory (agent_episodes) — what the agent actually did. MEMORY semantics with the THE-238 reader contract enforced: only evaluator-approved (eligible) episodes by default, tombstoned/expired rows never surface, results are partitioned to the calling principal, and a trust floor (default 0.3) excludes high-risk content. include_pending opts into not-yet-evaluated episodes (still trust-floored); any_caller crosses the agent partition and requires the admin:workspace scope (P1.7: the partition is an authorization boundary, not a free filter).",
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
        })
        .strict(),
      requiredScopes: ["read:workspace"],
      tags: ["experiential", "search"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        const clauses = ["blocked = 0", "(valid_until IS NULL OR valid_until > ?)"];
        const params: unknown[] = [now()];
        if (input.include_pending) {
          clauses.push("eligibility IN ('eligible', 'pending')");
        } else {
          clauses.push("eligibility = 'eligible'");
        }
        clauses.push("(trust IS NULL OR trust >= ?)");
        params.push(input.min_trust);
        // P1.7: any_caller crosses the agent partition — an authorization boundary, not a free
        // filter. Without the elevated scope it is a forbidden request, not a silent self-scope.
        if (input.any_caller && !canCrossPrincipal(ctx))
          throw err.forbidden(`any_caller requires the ${CROSS_PRINCIPAL_SCOPE} scope`);
        if (!input.any_caller) {
          clauses.push("caller IS ?");
          params.push(ctx.caller ?? null);
        }
        if (input.tool) {
          clauses.push("tool = ?");
          params.push(input.tool);
        }
        if (input.session_id) {
          clauses.push("session_id = ?");
          params.push(input.session_id);
        }
        if (input.since !== undefined) {
          clauses.push("ts >= ?");
          params.push(input.since);
        }
        if (input.until !== undefined) {
          clauses.push("ts <= ?");
          params.push(input.until);
        }
        if (input.query) {
          clauses.push(
            "(tool LIKE '%' || ? || '%' OR summary LIKE '%' || ? || '%' OR tags LIKE '%' || ? || '%' OR args_json LIKE '%' || ? || '%')",
          );
          params.push(input.query, input.query, input.query, input.query);
        }
        const rows = deps.edb
          .prepare(
            `SELECT id, ts, vault_id, session_id, caller, channel, episode_type, tool, status,
                    error_code, duration_ms, result_size, summary, tags, trust, eligibility,
                    blocked, prev_id
             FROM agent_episodes WHERE ${clauses.join(" AND ")}
             ORDER BY ts DESC LIMIT ?`,
          )
          .all(...params, input.k) as EpisodeRow[];
        return {
          available: true,
          floor: { min_trust: input.min_trust, include_pending: input.include_pending },
          results: rows.map(projectEpisode),
        };
      },
    }),

    defineTool({
      name: "work_episodes",
      description:
        "List/inspect the raw experiential episode log (management surface, the first-party list/inspect verb). Shows pending and ineligible state for review; tombstoned rows stay hidden unless include_blocked. Partitioned to the calling principal unless any_caller, which requires the admin:workspace scope (P1.7).",
      inputSchema: z
        .object({
          session_id: z.string().optional(),
          tool: z.string().optional(),
          status: z.enum(["ok", "error", "skipped"]).optional(),
          ...TimeFilters,
          include_blocked: z.boolean().default(false),
          any_caller: z.boolean().default(false),
          k: z.number().int().positive().max(500).default(50),
        })
        .strict(),
      requiredScopes: ["read:workspace"],
      tags: ["experiential"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        const clauses = ["1=1"];
        const params: unknown[] = [];
        if (!input.include_blocked) clauses.push("blocked = 0");
        // P1.7: any_caller crosses the agent partition — an authorization boundary, not a free
        // filter. Without the elevated scope it is a forbidden request, not a silent self-scope.
        if (input.any_caller && !canCrossPrincipal(ctx))
          throw err.forbidden(`any_caller requires the ${CROSS_PRINCIPAL_SCOPE} scope`);
        if (!input.any_caller) {
          clauses.push("caller IS ?");
          params.push(ctx.caller ?? null);
        }
        if (input.session_id) {
          clauses.push("session_id = ?");
          params.push(input.session_id);
        }
        if (input.tool) {
          clauses.push("tool = ?");
          params.push(input.tool);
        }
        if (input.status) {
          clauses.push("status = ?");
          params.push(input.status);
        }
        if (input.since !== undefined) {
          clauses.push("ts >= ?");
          params.push(input.since);
        }
        if (input.until !== undefined) {
          clauses.push("ts <= ?");
          params.push(input.until);
        }
        const rows = deps.edb
          .prepare(
            `SELECT id, ts, vault_id, session_id, caller, channel, episode_type, tool, status,
                    error_code, duration_ms, result_size, summary, tags, trust, eligibility,
                    blocked, prev_id
             FROM agent_episodes WHERE ${clauses.join(" AND ")}
             ORDER BY ts DESC LIMIT ?`,
          )
          .all(...params, input.k) as EpisodeRow[];
        return { available: true, episodes: rows.map(projectEpisode) };
      },
    }),

    defineTool({
      name: "work_forget",
      description:
        "Tombstone an experiential episode (the THE-238 control-1 blocklist, surfaced as the first-party forget verb). A forgotten episode never surfaces in work_search again; the append-only log row remains for forensics. Idempotent. P1.7: only your OWN episodes unless you hold admin:workspace — a foreign or unknown id is a silent no-op (forgotten:false), not an error.",
      inputSchema: z.object({ episode_id: z.string().min(1) }).strict(),
      requiredScopes: ["write:workspace"],
      tags: ["experiential"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        // P1.7: forget only your OWN episodes unless you hold the elevated scope. The caller
        // predicate is added to the UPDATE (not a pre-check) so a foreign/absent id is a silent
        // no-op (forgotten:false) — no cross-principal existence oracle.
        const res = canCrossPrincipal(ctx)
          ? deps.edb
              .prepare("UPDATE agent_episodes SET blocked = 1 WHERE id = ? AND blocked = 0")
              .run(input.episode_id)
          : deps.edb
              .prepare(
                "UPDATE agent_episodes SET blocked = 1 WHERE id = ? AND blocked = 0 AND caller IS ?",
              )
              .run(input.episode_id, ctx.caller ?? null);
        return { available: true, episode_id: input.episode_id, forgotten: res.changes > 0 };
      },
    }),

    defineTool({
      name: "record_retrieval_feedback",
      description:
        "Stamp relevance feedback and/or the THE-230 outcome axis (-1|0|+1) onto the most recent retrieval event(s) for a chunk in the experiential log. feedback = 'was this the right chunk'; outcome = 'did acting on it lead somewhere good'. Feeds the ACT-R activation recompute. P1.7: scoped to a session (the given session_id, else your active session); an unscoped cross-session stamp requires admin:workspace.",
      inputSchema: z
        .object({
          chunk_id: z.string().min(1),
          feedback: z.number().int().min(-1).max(1).optional(),
          outcome: z.number().int().min(-1).max(1).optional(),
          session_id: z.string().optional(),
          last_n: z.number().int().positive().max(50).default(1),
        })
        .strict()
        .refine((v) => v.feedback !== undefined || v.outcome !== undefined, {
          message: "provide feedback and/or outcome",
        }),
      requiredScopes: ["write:workspace"],
      tags: ["experiential"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        // P1.7: chunk_retrievals carries no caller attribution, so the enforceable partition is the
        // session. A non-elevated caller may only stamp feedback within a session (the explicit
        // session_id, or their own active session); an unscoped cross-session stamp requires the
        // elevated scope. True per-caller feedback ownership needs a caller column on
        // chunk_retrievals — tracked as a THE-230 follow-up.
        const session = input.session_id ?? ctx.sessionId;
        if (session === undefined && !canCrossPrincipal(ctx))
          throw err.forbidden(
            `stamping feedback across sessions requires a session_id or the ${CROSS_PRINCIPAL_SCOPE} scope`,
          );
        const sessionClause = session !== undefined ? "AND session_id = ?" : "";
        const selectParams: unknown[] = [input.chunk_id];
        if (session !== undefined) selectParams.push(session);
        const res = deps.edb
          .prepare(
            `UPDATE chunk_retrievals
             SET feedback = COALESCE(?, feedback), outcome = COALESCE(?, outcome)
             WHERE id IN (
               SELECT id FROM chunk_retrievals WHERE chunk_id = ? ${sessionClause}
               ORDER BY retrieved_at DESC LIMIT ?
             )`,
          )
          .run(input.feedback ?? null, input.outcome ?? null, ...selectParams, input.last_n);
        return { available: true, chunk_id: input.chunk_id, updated: res.changes };
      },
    }),
  ];
}
