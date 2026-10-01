// The `agent_episodes` row shape shared by every m8 read tool (work_search, work_episodes,
// work_episode_chain): the raw row type, the outward-facing zod projection, and the two pure
// helpers (parseTags, projectEpisode) plus the one query helper (visiblePrevIds) that turn one
// into the other. Lifted out of experiential-tools.ts, which sits at biome's 700-line ceiling —
// see that file's header. A THIRD module rather than having work-search-tool.ts import from
// experiential-tools.ts (or vice versa): both tool files need this shape, and either direction of
// a direct import between them would be the circular dependency CLAUDE.md's tool-split guidance
// warns about (check:boundaries baseline is 0).
import { z } from "zod";
import type { Database } from "../../db/types";

/** Mirrors `projectEpisode()` field for field. Written from the PROJECTION, not from EpisodeRow —
 *  the projection renames (`vault_id` -> `vault`), derives (`tags` parsed from JSON, `blocked`
 *  narrowed to a boolean, `prev_id` filtered through the caller's own visible set), so a schema
 *  built from the row type would be wrong in four places. */
export const EpisodeProjection = z.object({
  id: z.string(),
  ts: z.number(),
  // GH #1027: response_format=concise (see conciseEpisode) drops vault, caller, channel,
  // episode_type, duration_ms, result_size and a false `blocked`, and omits every null or empty
  // field, so all of those are optional here; a detailed projection always carries all of them.
  vault: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  caller: z.string().nullable().optional(),
  channel: z.string().optional(),
  episode_type: z.string().optional(),
  // THE-726: the verdict and the other half of its window identity. Exposed because the design
  // REQUIRES every consumer to group on `(session_id, verdict_at)` — a verdict is rendered once per
  // session window and projected onto N rows, so a reader that treats these as N independent
  // judgements double-counts. Requiring that and then hiding both fields would leave an MCP client
  // with no way to comply, and no way to see its own debt clear.
  task_result: z.number().nullable().optional(),
  verdict_at: z.number().nullable().optional(),
  tool: z.string().nullable().optional(),
  status: z.string(),
  error_code: z.string().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  result_size: z.number().nullable().optional(),
  summary: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  trust: z.number().nullable().optional(),
  eligibility: z.string(),
  blocked: z.boolean().optional(),
  // THE-655: the amendment chain link (episodes/createEpisodeCapture builds it per-caller, so it
  // never crosses the caller partition on its own). NULL when there is no predecessor OR when the
  // predecessor is tombstoned — see visiblePrevIds() below.
  prev_id: z.string().nullable().optional(),
});

export interface EpisodeRow {
  id: string;
  ts: number;
  vault_id: string | null;
  session_id: string | null;
  caller: string | null;
  channel: string;
  episode_type: string;
  task_result: number | null;
  verdict_at: number | null;
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

export function parseTags(tags: string | null): string[] {
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
export function visiblePrevIds(edb: Database, rows: EpisodeRow[]): Set<string> {
  const ids = [...new Set(rows.map((r) => r.prev_id).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Set();
  const rs = edb
    .prepare(
      `SELECT id FROM agent_episodes WHERE blocked = 0 AND id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as { id: string }[];
  return new Set(rs.map((r) => r.id));
}

export function projectEpisode(r: EpisodeRow, visiblePrev: Set<string>) {
  return {
    id: r.id,
    ts: r.ts,
    vault: r.vault_id,
    session_id: r.session_id,
    caller: r.caller,
    channel: r.channel,
    episode_type: r.episode_type,
    task_result: r.task_result,
    verdict_at: r.verdict_at,
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

/** GH #1027: the concise episode. Keeps what a reader acts on: the id and time, the tool and its
 *  status, the summary, and the provenance that decides whether to trust it (`trust`, `eligibility`,
 *  and `blocked` when true). `session_id` and a non-null `verdict_at` / `task_result` stay because
 *  work_result stamps verdicts per `(session_id, verdict_at)` window, so a caller reading its debt
 *  needs them to clear it. Dropped: vault, caller, channel, episode_type, duration_ms, result_size,
 *  a false `blocked`, and every null or empty field. */
export function conciseEpisode(p: ReturnType<typeof projectEpisode>) {
  return {
    id: p.id,
    ts: p.ts,
    ...(p.session_id !== null ? { session_id: p.session_id } : {}),
    ...(p.tool !== null ? { tool: p.tool } : {}),
    status: p.status,
    ...(p.error_code !== null ? { error_code: p.error_code } : {}),
    ...(p.summary !== null ? { summary: p.summary } : {}),
    ...(p.tags.length > 0 ? { tags: p.tags } : {}),
    ...(p.trust !== null ? { trust: p.trust } : {}),
    eligibility: p.eligibility,
    ...(p.blocked ? { blocked: true } : {}),
    ...(p.task_result !== null ? { task_result: p.task_result } : {}),
    ...(p.verdict_at !== null ? { verdict_at: p.verdict_at } : {}),
    ...(p.prev_id !== null ? { prev_id: p.prev_id } : {}),
  };
}

export const TimeFilters = {
  since: z.number().int().positive().optional(),
  until: z.number().int().positive().optional(),
};
