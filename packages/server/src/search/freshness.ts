// THE-450 — note-content freshness for retrieval hits.
//
// Stamps a hit with { age_days, stale } from the note's mtime so an agent can weigh a hit's age
// ("this note is 2y old — verify before relying"). Purely INFORMATIONAL and additive: it never
// changes ranking. This is vault-note CONTENT age, distinct from the experiential retrieval-log decay
// (usage recency). A recency RE-RANK blend is a separate, eval-gated experiment — deliberately not here.
import type { Database } from "../db/types";

const DAY_MS = 86_400_000;

/** Notes older than this (by mtime) are flagged stale. ~1 year — long enough that a still-current
 *  reference is not nagged, short enough that genuinely dated material is surfaced. */
export const STALE_THRESHOLD_DAYS = 365;

export interface Freshness {
  age_days: number;
  stale: boolean;
}

/** Compute a note's freshness from its mtime. A future mtime (clock skew) clamps to age 0. */
export function noteFreshness(
  mtimeMs: number,
  nowMs: number,
  staleThresholdDays: number = STALE_THRESHOLD_DAYS,
): Freshness {
  const age_days = Math.max(0, Math.floor((nowMs - mtimeMs) / DAY_MS));
  return { age_days, stale: age_days > staleThresholdDays };
}

/** Batch-fetch note mtimes for the given paths in one query, scoped to the vault. Absent paths are
 *  simply missing from the map (a hit whose note row was pruned gets no freshness stamp). */
export function mtimesByPath(db: Database, vaultId: string, paths: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (paths.length === 0) return out;
  const placeholders = paths.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT path, mtime FROM notes WHERE vault_id = ? AND path IN (${placeholders})`)
    .all(vaultId, ...paths) as Array<{ path: string; mtime: number }>;
  for (const r of rows) out.set(r.path, r.mtime);
  return out;
}
