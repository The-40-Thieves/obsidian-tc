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
  vault: z.string().nullable(),
  session_id: z.string().nullable(),
  caller: z.string().nullable(),
  channel: z.string(),
  episode_type: z.string(),
  // THE-726: the verdict and the other half of its window identity. Exposed because the design
  // REQUIRES every consumer to group on `(session_id, verdict_at)` — a verdict is rendered once per
  // session window and projected onto N rows, so a reader that treats these as N independent
  // judgements double-counts. Requiring that and then hiding both fields would leave an MCP client
  // with no way to comply, and no way to see its own debt clear.
  task_result: z.number().nullable(),
  verdict_at: z.number().nullable(),
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

export const TimeFilters = {
  since: z.number().int().positive().optional(),
  until: z.number().int().positive().optional(),
};
