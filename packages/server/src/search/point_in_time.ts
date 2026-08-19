// THE-635 v1 — point-in-time retrieval, NARROW SCOPE. "search the vault as it was at date D" is
// harder than filtering `created_at <= D`: a note that existed at D but has since been edited
// would come back with its CURRENT content presented as the D-state, which is a false historical
// claim (see the ticket's "Why it is harder than it looks"). Full past-content reconstruction
// needs content history that does not uniformly exist (`vault/snapshots.ts` only captures
// agent-initiated destructive writes, retention 10 — partial and non-uniform), so this module does
// NOT attempt it. The honest v1 is a deterministic FILTER + FLAG, not a ranking change:
//   - exclude chunks that did not exist yet at D (created_at > D)
//   - flag every surviving chunk as either "unchanged since D" or "existed at D but has been
//     edited since" — the caller is NEVER handed current content silently presented as historical.
//
// Reuses the SAME {start, end} range shape `temporal.ts` already produces from query text (no
// second date parser here) rather than inventing a new range type: `range.end` is the
// point-in-time boundary D; `range.start` is the window's lower bound, applied to `updated_at` so
// a chunk with no activity anywhere in the requested window (last touched before `start`) is
// excluded as outside it, not merely stale-but-included.
import type { Database } from "../db/types";
import type { TemporalRange } from "./temporal";

export interface PointInTimeChunk {
  id: string;
  path: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** false = "unchanged since D": the content returned IS what existed at D.
   *  true  = "existed at D but has been edited since": the content returned is CURRENT, not the
   *  D-state — callers must surface this rather than presenting it as historical. */
  changedSinceD: boolean;
}

/** Pure flag logic, split out from the DB query below so it is unit-testable without a fixture,
 *  the same split freshness.ts uses for noteFreshness vs mtimesByPath. */
export function changedSinceD(createdAtMs: number, updatedAtMs: number, dMs: number): boolean {
  return createdAtMs <= dMs && updatedAtMs > dMs;
}

/** Filter + flag chunks against a point-in-time window, scoped to one vault. `range` is exactly
 *  the TemporalRange shape `parseTemporalIntent` already produces — callers deriving D from query
 *  text pass that result straight through rather than parsing dates a second time.
 *
 *  A chunk created after `range.end` did not exist at D and is never returned (not flagged — there
 *  is no D-state for it to be "unchanged" or "changed" relative to). A chunk last updated before
 *  `range.start` had no activity anywhere in the requested window and is excluded as outside it.
 *  Every other chunk existing in the vault at D is returned, flagged via `changedSinceD`. */
export function filterChunksAsOf(
  db: Database,
  vaultId: string,
  range: TemporalRange,
): PointInTimeChunk[] {
  const rows = db
    .prepare(
      `SELECT id, path, content, created_at AS createdAt, updated_at AS updatedAt
       FROM chunks
       WHERE vault_id = ? AND created_at <= ? AND updated_at >= ?
       ORDER BY path, chunk_index`,
    )
    .all(vaultId, range.end, range.start) as Array<{
    id: string;
    path: string;
    content: string;
    createdAt: number;
    updatedAt: number;
  }>;
  return rows.map((r) => ({
    ...r,
    changedSinceD: changedSinceD(r.createdAt, r.updatedAt, range.end),
  }));
}
