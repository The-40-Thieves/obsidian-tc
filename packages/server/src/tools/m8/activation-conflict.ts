// THE-643 item 3 — reconciling note_quality's `stale_access` flag against activation.
//
// stale_access (experiential/note-quality.ts, note granularity, 30-day RETRIEVAL cutoff) and
// cached_activation_score (experiential/activation.ts, CHUNK granularity, ACT-R recency/frequency
// decay) are two independently-computed signals with zero cross-references today — a note can
// carry stale_access while its chunks still read as "live" to the ranker, or the reverse, and
// nothing surfaces the disagreement. Per note-quality.ts's own header ("two definitional conflicts
// resolved here EXPLICITLY... blending them would produce a number that answers neither question"),
// this module does NOT unify the two into one score. It SURFACES the disagreement as a boolean on
// note_quality_report's output — a read-only diagnostic, matching that tool's own "never used for
// ranking" contract.
import type { Database } from "../../db/types";

/** Mirrors activation.ts's cold-start default (actrActivation: `events.length === 0` -> 0.5) and
 *  THE-193's stale-floor clamp (a raw score below 0.5 with no negative feedback is clamped UP to
 *  0.5). A chunk reading at or under this floor is one ACT-R currently treats as neutral-or-below
 *  — either never retrieved, or old enough that the floor clamped it there. */
export const ACTIVATION_NEUTRAL_FLOOR = 0.5;

/** Cross-store id batching, matching note-quality.ts's own BATCH constant — chunks is keyed by
 *  (vault_id, path), so a page of note_quality rows becomes one batched IN() lookup rather than
 *  one query per note. */
const BATCH = 200;

/**
 * path -> the MAX cached_activation_score across that note's chunks (THE-643's chosen aggregate:
 * a single hot chunk should suppress a `stale_access` flag's implied "nobody wants this" reading,
 * per the granularity mismatch note-quality.ts's header already calls out for note-vs-chunk
 * signals generally). `null` for a path with no chunks, or none of whose chunks carry a
 * vault_object_state row — "no activation data", not "activation is zero".
 */
export function maxActivationByPath(
  cacheDb: Database,
  vaultId: string,
  paths: string[],
  activationFor: (chunkId: string) => number | null,
): Map<string, number | null> {
  const out = new Map<string, number | null>(paths.map((p) => [p, null]));
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const rows = cacheDb
      .prepare(
        `SELECT id, path FROM chunks WHERE vault_id = ? AND path IN (${batch.map(() => "?").join(",")})`,
      )
      .all(vaultId, ...batch) as Array<{ id: string; path: string }>;
    for (const r of rows) {
      const score = activationFor(r.id);
      if (score === null) continue;
      const cur = out.get(r.path);
      out.set(r.path, cur === null || cur === undefined ? score : Math.max(cur, score));
    }
  }
  return out;
}

/**
 * The conflict rule, isolated from the DB/batching plumbing above so it is directly unit-testable.
 *
 * `null` aggregate (no activation data for any of the note's chunks) is ALWAYS false — there is
 * nothing to disagree with, and reading "no data" as a conflict would be exactly the false-signal
 * failure note-quality.ts's own quality_score NULL-vs-0.3 fix (THE-718) exists to avoid.
 *
 * Otherwise: `stale_access` + activation strictly ABOVE the neutral floor means ACT-R still treats
 * the note as more-than-neutral despite the note-level staleness signal — a conflict. The inverse
 * — no `stale_access` but activation AT OR UNDER the floor — means every one of the note's chunks
 * currently reads as neutral-or-below to the ranker despite note_quality not flagging it stale —
 * also a conflict.
 */
export function activationConflict(maxActivation: number | null, staleAccess: boolean): boolean {
  if (maxActivation === null) return false;
  return staleAccess
    ? maxActivation > ACTIVATION_NEUTRAL_FLOOR
    : maxActivation <= ACTIVATION_NEUTRAL_FLOOR;
}
