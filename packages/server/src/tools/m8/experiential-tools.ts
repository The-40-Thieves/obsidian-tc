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
import { randomUUID } from "node:crypto";
import { err, grantsAll, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { Database } from "../../db/types";
import { appendForgetLog } from "../../experiential/forget";
import {
  DEFAULT_GAP_MIN_RESULTS,
  DEFAULT_GAP_THRESHOLD,
  readLatestGapReport,
} from "../../experiential/gaps";
import { closeGoal, listGoals, setGoal } from "../../experiential/goals";
import { readNoteQuality } from "../../experiential/note-quality";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { readableRel } from "../../vault/acl-read-filter";
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

// Annotated rather than inferred: a bare object literal widens `available` to `boolean`, which no
// longer matches `Unavailable`'s `z.literal(false)` once a handler's return union is checked
// structurally. Annotating pins the discriminant while leaving `message` a plain `string` — `as
// const` would also freeze the message into a literal type, which is not wanted.
const UNAVAILABLE: { available: false; message: string } = {
  available: false,
  message:
    "experiential store is not open (enable experiential.logRetrievals, captureEpisodes, or activationRerank)",
};

/** THE-417: the degraded half of every m8 tool's output contract, declared once beside the value it
 *  describes so the two cannot drift. Every tool here returns EITHER this shape or `available: true`
 *  plus its own fields — a discriminated union on `available`, which is what makes these payloads
 *  worth advertising a schema for at all: an agent can branch on one field instead of guessing.
 *
 *  THE-548 found three different "unavailable" shapes across the tool surface (m8's shared object,
 *  m7's ad-hoc `available:false`, and M4 throwing `plugin_missing`). Declaring the contract is what
 *  turns that from a thing you discover by reading handlers into a thing the registry checks. */
const Unavailable = z.object({ available: z.literal(false), message: z.string() });

/** `available: true` plus the tool's own fields. */
function availableWith<T extends z.ZodRawShape>(shape: T) {
  return z.union([Unavailable, z.object({ available: z.literal(true), ...shape })]);
}

/** Mirrors `projectEpisode()` field for field. Written from the PROJECTION, not from EpisodeRow —
 *  the projection renames (`vault_id` -> `vault`), derives (`tags` parsed from JSON, `blocked`
 *  narrowed to a boolean, `prev_id` filtered through the caller's own visible set), so a schema
 *  built from the row type would be wrong in four places. */
const EpisodeProjection = z.object({
  id: z.string(),
  ts: z.number(),
  vault: z.string().nullable(),
  session_id: z.string().nullable(),
  caller: z.string().nullable(),
  channel: z.string(),
  episode_type: z.string(),
  tool: z.string().nullable(),
  status: z.string(),
  error_code: z.string().nullable(),
  duration_ms: z.number().nullable(),
  result_size: z.number().nullable(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
  trust: z.number().nullable(),
  eligibility: z.string(),
  blocked: z.boolean(),
  // THE-655: the amendment chain link (episodes/createEpisodeCapture builds it per-caller, so it
  // never crosses the caller partition on its own). NULL when there is no predecessor OR when the
  // predecessor is tombstoned — see visiblePrevIds() below.
  prev_id: z.string().nullable(),
});

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

/** THE-655: an amendment chain can point at a tombstoned predecessor — work_search's control 1
 *  ("blocked rows NEVER surface") is documented absolute, and a raw `prev_id` pointing at a
 *  blocked row would leak that row's id (and its existence in the chain) even though the row
 *  itself never surfaces. The chain is built per-CALLER (episodes.ts's `prevByCaller`/
 *  `selectLastByCaller` both key on `caller IS ?`), so it can never cross the caller partition on
 *  its own — the only thing left to filter is the tombstone. One batched follow-up query per
 *  handler call (not per row) resolves which referenced predecessors are still visible. */
function visiblePrevIds(edb: Database, rows: EpisodeRow[]): Set<string> {
  const ids = [...new Set(rows.map((r) => r.prev_id).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Set();
  const rs = edb
    .prepare(
      `SELECT id FROM agent_episodes WHERE blocked = 0 AND id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as { id: string }[];
  return new Set(rs.map((r) => r.id));
}

function projectEpisode(r: EpisodeRow, visiblePrev: Set<string>) {
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
    prev_id: r.prev_id !== null && visiblePrev.has(r.prev_id) ? r.prev_id : null,
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
      domain: "knowledge",
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
      outputSchema: availableWith({
        floor: z.object({ min_trust: z.number(), include_pending: z.boolean() }),
        results: z.array(EpisodeProjection),
      }),
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
        const visiblePrev = visiblePrevIds(deps.edb, rows);
        return {
          available: true,
          floor: { min_trust: input.min_trust, include_pending: input.include_pending },
          results: rows.map((r) => projectEpisode(r, visiblePrev)),
        };
      },
    }),

    defineTool({
      name: "work_episodes",
      domain: "knowledge",
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
      outputSchema: availableWith({ episodes: z.array(EpisodeProjection) }),
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
        const visiblePrev = visiblePrevIds(deps.edb, rows);
        return { available: true, episodes: rows.map((r) => projectEpisode(r, visiblePrev)) };
      },
    }),

    defineTool({
      name: "work_episode_chain",
      domain: "knowledge",
      description:
        "Walk an episode's amendment chain in one call. `prev_id` links each episode to the caller's previous one, and following it hop by hop cost one round trip per link. Returns the chain newest-first starting at `id`. The THE-238 reader contract applies at every hop, not just the first: tombstoned rows never surface, expired rows are excluded, and the walk stays inside the calling principal unless any_caller (admin:workspace, P1.7). The walk STOPS at the first hop that fails those filters rather than skipping over it — a gap in a returned chain would itself disclose that a hidden episode exists.",
      inputSchema: z
        .object({
          id: z.string().min(1),
          k: z.number().int().positive().max(200).default(50),
          any_caller: z.boolean().default(false),
        })
        .strict(),
      outputSchema: availableWith({
        chain: z.array(EpisodeProjection),
        /** True when the walk stopped on `k` rather than on a genuine chain end, so a caller can
         *  tell "this is the whole chain" from "there is more". */
        truncated: z.boolean(),
      }),
      requiredScopes: ["read:workspace"],
      tags: ["experiential"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        // P1.7: identical boundary to work_search/work_episodes — crossing the partition is an
        // authorization decision, not a filter, so it is refused rather than silently self-scoped.
        if (input.any_caller && !canCrossPrincipal(ctx))
          throw err.forbidden(`any_caller requires the ${CROSS_PRINCIPAL_SCOPE} scope`);

        const clauses = ["id = ?", "blocked = 0", "(valid_until IS NULL OR valid_until > ?)"];
        if (!input.any_caller) clauses.push("caller IS ?");
        const stmt = deps.edb.prepare(
          `SELECT id, ts, vault_id, session_id, caller, channel, episode_type, tool, status,
                  error_code, duration_ms, result_size, summary, tags, trust, eligibility,
                  blocked, prev_id
           FROM agent_episodes WHERE ${clauses.join(" AND ")}`,
        );
        const fetch = (id: string): EpisodeRow | undefined => {
          const params: unknown[] = [id, now()];
          if (!input.any_caller) params.push(ctx.caller ?? null);
          return stmt.get(...params) as EpisodeRow | undefined;
        };

        const chain: EpisodeRow[] = [];
        // A corrupted or maliciously-constructed prev_id cycle would otherwise loop forever; the
        // walk is bounded by `k` anyway, but `seen` makes termination independent of that bound.
        const seen = new Set<string>();
        let cursor: string | null = input.id;
        while (cursor !== null && chain.length < input.k && !seen.has(cursor)) {
          seen.add(cursor);
          const row = fetch(cursor);
          if (!row) break; // missing, tombstoned, expired, or another principal's — stop here
          chain.push(row);
          cursor = row.prev_id;
        }
        const truncated = chain.length === input.k && chain[chain.length - 1]?.prev_id !== null;
        const visiblePrev = visiblePrevIds(deps.edb, chain);
        return {
          available: true,
          chain: chain.map((r) => projectEpisode(r, visiblePrev)),
          truncated,
        };
      },
    }),

    defineTool({
      name: "episode_stats",
      domain: "knowledge",
      description:
        "Aggregate activity counts over the experiential episode log WITHOUT returning any episode content. work_search/work_episodes are all-or-nothing: seeing activity patterns otherwise requires admin:workspace, which also grants full row content. This returns counts only, so an operator can answer 'what is this agent doing' without reading what it did. Grouping by caller is not offered — the group_by enum excludes it deliberately. Buckets smaller than min_bucket are withheld and summed into `suppressed`, because a count of 1 in a narrow bucket is equivalent to reading the row.",
      inputSchema: z
        .object({
          group_by: z.enum(["tool", "status", "eligibility"]).default("tool"),
          ...TimeFilters,
          /** k-anonymity floor. Raising it is allowed; lowering it below 2 is not, because a
           *  bucket of 1 identifies a single episode. */
          min_bucket: z.number().int().min(2).max(1000).default(5),
          limit: z.number().int().positive().max(200).default(50),
        })
        .strict(),
      outputSchema: availableWith({
        group_by: z.string(),
        min_bucket: z.number(),
        buckets: z.array(z.object({ key: z.string().nullable(), count: z.number() })),
        /** Total rows in buckets that fell below min_bucket, reported as one number so the totals
         *  still reconcile without disclosing the small buckets themselves. */
        suppressed: z.number(),
        suppressed_buckets: z.number(),
        total: z.number(),
      }),
      requiredScopes: ["read:workspace"],
      tags: ["experiential"],
      handler: (input, _ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        // Tombstoned and expired rows are excluded for the same reason they are excluded from
        // work_search: a count that includes them discloses their existence.
        const clauses = ["blocked = 0", "(valid_until IS NULL OR valid_until > ?)"];
        const params: unknown[] = [now()];
        if (input.since !== undefined) {
          clauses.push("ts >= ?");
          params.push(input.since);
        }
        if (input.until !== undefined) {
          clauses.push("ts <= ?");
          params.push(input.until);
        }
        // `group_by` is a closed enum, never interpolated from free input — and it deliberately
        // cannot name `caller`.
        const col = input.group_by;
        const rows = deps.edb
          .prepare(
            `SELECT ${col} AS key, COUNT(*) AS n FROM agent_episodes
             WHERE ${clauses.join(" AND ")} GROUP BY ${col} ORDER BY n DESC`,
          )
          .all(...params) as Array<{ key: string | null; n: number }>;

        const kept = rows.filter((r) => r.n >= input.min_bucket);
        const small = rows.filter((r) => r.n < input.min_bucket);
        return {
          // `as const` keeps this the literal `true` rather than widening to `boolean`: the two
          // return branches (UNAVAILABLE and this) otherwise infer a union that no longer matches
          // the discriminated availableWith() shape.
          available: true as const,
          group_by: input.group_by,
          min_bucket: input.min_bucket,
          buckets: kept.slice(0, input.limit).map((r) => ({ key: r.key, count: r.n })),
          suppressed: small.reduce((a, r) => a + r.n, 0),
          suppressed_buckets: small.length,
          total: rows.reduce((a, r) => a + r.n, 0),
        };
      },
    }),

    defineTool({
      name: "work_forget",
      domain: "knowledge",
      description:
        "Tombstone an experiential episode (the THE-238 control-1 blocklist, surfaced as the first-party forget verb). A forgotten episode never surfaces in work_search again; each successful forget appends a THE-239 hash-chained forget_log row for forensics. Idempotent: a repeat call, foreign, or unknown episode id is a silent no-op (forgotten:false) that appends NO additional log row. P1.7: only your OWN episodes unless you hold admin:workspace — a foreign or unknown id is a silent no-op, not an error.",
      inputSchema: z.object({ episode_id: z.string().min(1) }).strict(),
      outputSchema: availableWith({ episode_id: z.string(), forgotten: z.boolean() }),
      requiredScopes: ["write:workspace"],
      tags: ["experiential"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        // THE-600: the tombstone and the THE-239 hash-chained forget_log append must be atomic —
        // mirrors forgetEpisode()'s C1 guarantee (experiential/forget.ts) that a crash between the
        // two never leaves a tombstone with no audit row.
        let changes = 0;
        deps.edb.exec("BEGIN");
        try {
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
          changes = res.changes as number;
          // Only append when a real transition happened. work_forget is documented idempotent — a
          // repeat call, a foreign id, or an unknown id already yields changes === 0 via the
          // predicate above, so logging unconditionally here would spam the hash chain and make a
          // replayed no-op indistinguishable from a real forget.
          if (changes > 0) {
            appendForgetLog(deps.edb, {
              ts: now(),
              kind: "episode",
              target: input.episode_id,
              mode: "tombstone",
              details: { actor: ctx.caller ?? null, source: "work_forget" },
            });
          }
          deps.edb.exec("COMMIT");
        } catch (e) {
          deps.edb.exec("ROLLBACK");
          throw e;
        }
        return { available: true, episode_id: input.episode_id, forgotten: changes > 0 };
      },
    }),

    // ---- THE-633: stated goals ----
    //
    // Three verbs, no fourth. There is deliberately NO update_goal and NO reopen: the decision's
    // authority-monotonicity constraint means a goal moves open -> terminal exactly once, and a verb
    // that mutated an existing goal would be the low-confidence write path the whole design excludes.
    // Provenance is hard-coded 'stated' in the store and CHECK-pinned in the migration, so an
    // inferred write is a constraint violation rather than a convention.
    defineTool({
      name: "set_goal",
      domain: "knowledge",
      description:
        "Record a STATED goal for a vault — what the user is trying to accomplish, as distinct from a learned preference (a preference is 'you tend to X' and never resolves; a goal is 'you intend to X' and ends in completed/abandoned/expired). Goals are stated by the user and never inferred: nothing in the reflect/extract path can write one. An optional target_date lets the expiry sweep mark it 'expired' rather than leaving stale intent to bias later reads.",
      inputSchema: z
        .object({
          vault: z.string().min(1),
          text: z.string().min(1).max(2000),
          target_date: z.number().int().positive().optional(),
        })
        .strict(),
      outputSchema: availableWith({
        id: z.string(),
        vault: z.string(),
        text: z.string(),
        status: z.string(),
        created_at: z.number(),
        target_date: z.number().nullable(),
      }),
      requiredScopes: ["write:workspace"],
      tags: ["experiential"],
      handler: (input) => {
        if (!deps.edb) return UNAVAILABLE;
        const now = Date.now();
        const row = setGoal(deps.edb, {
          id: randomUUID(),
          vaultId: input.vault,
          text: input.text,
          createdAt: now,
          ...(input.target_date !== undefined ? { targetDate: input.target_date } : {}),
        });
        return {
          available: true as const,
          id: row.id,
          vault: row.vault_id,
          text: row.text,
          status: row.status,
          created_at: row.created_at,
          target_date: row.target_date,
        };
      },
    }),

    defineTool({
      name: "list_goals",
      domain: "knowledge",
      description:
        "List a vault's stated goals, newest first. Defaults to OPEN goals only — a consumer that forgets to filter should see current intent rather than a graveyard of closed ones. Pass status to narrow to a terminal state, or 'any' for the full history. 'expired' (the deadline sweep's verdict) and 'abandoned' (the user's) are deliberately distinct and must not be counted together.",
      inputSchema: z
        .object({
          vault: z.string().min(1),
          status: z
            .enum(["open", "completed", "abandoned", "expired", "any"])
            .default("open"),
          limit: z.number().int().positive().max(200).default(50),
        })
        .strict(),
      outputSchema: availableWith({
        vault: z.string(),
        count: z.number().int(),
        goals: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            status: z.string(),
            source: z.string(),
            created_at: z.number(),
            target_date: z.number().nullable(),
            closed_at: z.number().nullable(),
          }),
        ),
      }),
      requiredScopes: ["read:notes"],
      tags: ["experiential", "knowledge"],
      handler: (input) => {
        if (!deps.edb) return UNAVAILABLE;
        const rows = listGoals(deps.edb, input.vault, {
          status: input.status,
          limit: input.limit,
        });
        return {
          available: true as const,
          vault: input.vault,
          count: rows.length,
          goals: rows.map((r) => ({
            id: r.id,
            text: r.text,
            status: r.status,
            source: r.source,
            created_at: r.created_at,
            target_date: r.target_date,
            closed_at: r.closed_at,
          })),
        };
      },
    }),

    defineTool({
      name: "close_goal",
      domain: "knowledge",
      description:
        "Close a stated goal into a terminal state: completed or abandoned. Once-only — a second close reports closed:false rather than silently succeeding, and there is no reopen verb, because a system that quietly reopened a goal the user completed is exactly the low-confidence mutation this plane forbids. 'expired' is not settable here; it is the deadline sweep's verdict alone.",
      inputSchema: z
        .object({
          vault: z.string().min(1),
          id: z.string().min(1),
          status: z.enum(["completed", "abandoned"]),
        })
        .strict(),
      outputSchema: availableWith({
        closed: z.boolean(),
        id: z.string(),
        status: z.string().nullable(),
        closed_at: z.number().nullable(),
      }),
      requiredScopes: ["write:workspace"],
      tags: ["experiential"],
      handler: (input) => {
        if (!deps.edb) return UNAVAILABLE;
        const row = closeGoal(deps.edb, {
          id: input.id,
          vaultId: input.vault,
          status: input.status,
          closedAt: Date.now(),
        });
        // null covers BOTH "no such goal in this vault" and "already closed". Reported as
        // closed:false rather than an error: neither is exceptional, and the caller needs to be able
        // to tell that nothing happened.
        return {
          available: true as const,
          closed: row !== null,
          id: input.id,
          status: row?.status ?? null,
          closed_at: row?.closed_at ?? null,
        };
      },
    }),

    defineTool({
      name: "record_retrieval_feedback",
      domain: "knowledge",
      description:
        "Stamp relevance feedback and/or the THE-230 outcome axis (-1|0|+1) onto the most recent retrieval event(s) for a chunk in the experiential log. feedback = 'was this the right chunk'; outcome = 'did acting on it lead somewhere good'. Feeds the ACT-R activation recompute. THE-568: gated on per-caller ownership — a non-elevated caller may only stamp retrievals it caused itself; also scoped to a session (the given session_id, else your active session), an unscoped cross-session stamp requires admin:workspace.",
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
      outputSchema: availableWith({ chunk_id: z.string(), updated: z.number().int() }),
      requiredScopes: ["write:workspace"],
      tags: ["experiential"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        // THE-568 (P1.7 follow-up): chunk_retrievals now carries a caller column, so the primary
        // authorization boundary is per-caller ownership — a non-elevated caller may only stamp
        // retrievals it caused itself (AND caller IS ? below), mirroring the agent_episodes
        // partition. The pre-existing session scoping is kept as an additional narrowing on top:
        // a non-elevated caller still needs a session_id or active session to stamp at all.
        const session = input.session_id ?? ctx.sessionId;
        const crossPrincipal = canCrossPrincipal(ctx);
        if (session === undefined && !crossPrincipal)
          throw err.forbidden(
            `stamping feedback across sessions requires a session_id or the ${CROSS_PRINCIPAL_SCOPE} scope`,
          );
        const sessionClause = session !== undefined ? "AND session_id = ?" : "";
        const callerClause = crossPrincipal ? "" : "AND caller IS ?";
        const selectParams: unknown[] = [input.chunk_id];
        if (session !== undefined) selectParams.push(session);
        if (!crossPrincipal) selectParams.push(ctx.caller ?? null);
        const res = deps.edb
          .prepare(
            `UPDATE chunk_retrievals
             SET feedback = COALESCE(?, feedback), outcome = COALESCE(?, outcome)
             WHERE id IN (
               SELECT id FROM chunk_retrievals WHERE chunk_id = ? ${sessionClause} ${callerClause}
               ORDER BY retrieved_at DESC LIMIT ?
             )`,
          )
          .run(input.feedback ?? null, input.outcome ?? null, ...selectParams, input.last_n);
        return { available: true, chunk_id: input.chunk_id, updated: res.changes };
      },
    }),

    // THE-537: the read surface the quality signals never had. READ-ONLY and NOT the ranker —
    // quality_score is reported, never fed into fusion (that would be a ranking change needing its
    // own eval gate). The rollup is written by the offline `obsidian-tc note-quality` pass; this
    // tool only reads what that pass computed, so a stale `computed_at` is visible to the caller
    // rather than hidden behind a silent recompute.
    defineTool({
      name: "note_quality_report",
      domain: "knowledge",
      description:
        "Read-only note-health report from the note_quality rollup (THE-537): which notes are duplicated, orphaned, stale by edit or by access, contradicted, or tombstoned — with the raw components behind each verdict. quality_score is NULL when there is no usage evidence yet, which means UNMEASURED, not bad. Populated by the offline `obsidian-tc note-quality` pass; computed_at tells you how fresh it is. Never used for ranking.",
      inputSchema: z
        .object({
          vault: VaultId,
          flags: z
            .array(
              z.enum([
                "duplicate",
                "orphan",
                "stale_edit",
                "stale_access",
                "contradicted",
                "tombstoned",
              ]),
            )
            .optional(),
          limit: z.number().int().positive().max(500).default(50),
        })
        .strict(),
      outputSchema: availableWith({
        vault: z.string(),
        count: z.number().int(),
        // Null distinguishes a clean vault from a rollup that was never computed.
        computed_at: z.number().nullable(),
        notes: z.array(
          z.object({
            path: z.string(),
            quality_score: z.number().nullable(),
            score_version: z.number(),
            flags: z.array(z.string()),
            chunk_count: z.number(),
            dup_chunk_count: z.number(),
            dup_ratio: z.number().nullable(),
            age_days: z.number().nullable(),
            last_retrieved_at: z.number().nullable(),
            retrievals: z.number(),
            citations: z.number(),
            outcome_balance: z.number(),
            in_degree: z.number(),
            out_degree: z.number(),
            contradictions_open: z.number(),
            tombstoned: z.boolean(),
          }),
        ),
      }),
      requiredScopes: ["read:notes"],
      tags: ["experiential", "knowledge"],
      handler: (input) => {
        if (!deps.edb) return UNAVAILABLE;
        const rows = readNoteQuality(deps.edb, {
          vaultId: input.vault,
          ...(input.flags ? { flags: input.flags } : {}),
          limit: input.limit,
        });
        return {
          available: true,
          vault: input.vault,
          count: rows.length,
          // Surfaced so a caller can tell a clean vault from a rollup that was never computed.
          computed_at: rows[0]?.computed_at ?? null,
          notes: rows.map((r) => ({
            path: r.path,
            quality_score: r.quality_score,
            score_version: r.score_version,
            flags: JSON.parse(r.flags) as string[],
            chunk_count: r.chunk_count,
            dup_chunk_count: r.dup_chunk_count,
            dup_ratio: r.dup_ratio,
            age_days: r.age_days,
            last_retrieved_at: r.last_retrieved_at,
            retrievals: r.retrievals,
            citations: r.citations,
            outcome_balance: r.outcome_balance,
            in_degree: r.in_degree,
            out_degree: r.out_degree,
            contradictions_open: r.contradictions_open,
            tombstoned: r.tombstoned === 1,
          })),
        };
      },
    }),

    // THE-611: a read-only surface over the gap detector (THE-48/THE-616), modelled directly on
    // note_quality_report above (THE-548's audit precedent: the CLI recomputes, the MCP sibling
    // only reads). detectGaps embeds + runs a full graphSearch per query — expensive, and a
    // derived-state write, not something a dispatch call should trigger. THE-644 item 1 made the
    // read half possible by persisting the offline `obsidian-tc gaps` pass's report; this tool
    // reads the latest one back and NEVER calls detectGaps itself.
    defineTool({
      name: "gap_report",
      domain: "knowledge",
      description:
        "Read-only view of the latest gap-detector pass (THE-48/THE-616/THE-644): which of the pass's queries scored below the calibrated coverage floor, with their nearest-hit context. Populated by the offline `obsidian-tc gaps` pass; computed_at tells you how fresh it is, and null means no pass has ever been persisted for this vault. Never recomputes — a fresh reading requires re-running the CLI pass. Nearest-hit paths are filtered to the caller's read ACL (THE-563/564) before being returned.",
      inputSchema: z
        .object({
          vault: VaultId,
          gaps_only: z.boolean().default(false),
          limit: z.number().int().positive().max(500).default(50),
        })
        .strict(),
      outputSchema: availableWith({
        vault: z.string(),
        // Null distinguishes "no pass has ever run" from a pass that found nothing.
        computed_at: z.number().nullable(),
        threshold: z.number(),
        min_results: z.number().int(),
        // Pass-level stats — always over the FULL persisted pass, unaffected by gaps_only/limit.
        total: z.number().int(),
        gaps: z.number().int(),
        gap_rate: z.number(),
        // items.length after gaps_only/limit narrowing (and ACL-filtered nearest paths within it).
        returned: z.number().int(),
        items: z.array(
          z.object({
            id: z.string(),
            query: z.string(),
            top_score: z.number().nullable(),
            results: z.number().int(),
            gap: z.boolean(),
            nearest: z.array(z.object({ path: z.string(), score: z.number() })),
          }),
        ),
      }),
      requiredScopes: ["read:notes"],
      tags: ["experiential", "knowledge"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        // Null when no pass has ever been persisted for this vault — every field below falls
        // back to an honest "nothing measured yet" zero rather than throwing.
        const existing = readLatestGapReport(deps.edb, input.vault);
        const allItems = existing?.items ?? [];
        const filtered = input.gaps_only ? allItems.filter((i) => i.gap) : allItems;
        const items = filtered.slice(0, input.limit).map((i) => ({
          ...i,
          // THE-563/564: a gap report naming notes the caller cannot read is a disclosure — the
          // item itself (query/score/gap) carries no path, so only `nearest` needs filtering.
          nearest: i.nearest.filter((n) => readableRel(ctx.acl, n.path)),
        }));
        return {
          available: true,
          vault: existing?.vault_id ?? input.vault,
          computed_at: existing?.computed_at ?? null,
          threshold: existing?.threshold ?? DEFAULT_GAP_THRESHOLD,
          min_results: existing?.min_results ?? DEFAULT_GAP_MIN_RESULTS,
          total: existing?.total ?? 0,
          gaps: existing?.gaps ?? 0,
          gap_rate: existing?.gap_rate ?? 0,
          returned: items.length,
          items,
        };
      },
    }),
  ];
}
