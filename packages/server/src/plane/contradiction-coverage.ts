// THE-646: how much of a vault's contradiction check actually produced a VERDICT.
//
// THE-613 stopped the contradiction job fabricating `no_conflict` when the judge fails: an unjudged
// pair now returns null, the count leaves the function, and `plane-wiring.ts` THROWS so the job
// dead-letters instead of recording a false clean result. That closed the function boundary.
//
// It left the CONSUMER boundary open, and this module closes it. An unjudged pair writes no row —
// `contradiction.ts` says so in its own comment — so `synthesis.ts` selects `status = 'open'` and
// renders `(none)`. A vault whose contradiction jobs all dead-lettered during a gateway outage is
// therefore BYTE-IDENTICAL to a genuinely clear one, which is the false negative THE-613 was fixed
// to prevent, surfacing one layer up.
//
// Measured on the live store 2026-08-06, and this is not hypothetical:
//
//   jobs   type='contradiction'  state='complete'   482
//   jobs   type='contradiction'  state='failed'     159   <- all 159 last_error LIKE '%unjudged%'
//   contradictions  vault='main' status='open'        7
//
// So synthesis was reporting 7 contradictions while 159 checks had silently produced no verdict.
//
// NO NEW TABLE, deliberately. The durable record already exists: the job queue keeps a row per
// contradiction check with its terminal state, its `last_error`, and a payload carrying `vaultId`.
// Adding a `contradiction_runs` table beside it would be a second source of truth for a fact the
// first one already holds — and this ticket's own history warns that its scope had "grown beyond
// read-side only". It had not; the record was simply somewhere nobody had looked.
import type { Database } from "../db/types";

export interface ContradictionCoverage {
  /**
   * Checks that will never produce a verdict without manual requeue: `state = 'failed'`, the
   * terminal state after `max_attempts`.
   */
  deadLettered: number;
}

/** Zero coverage loss — the shape callers use when the job queue is unavailable. */
export const NO_COVERAGE_LOSS: ContradictionCoverage = { deadLettered: 0 };

/**
 * Contradiction checks for `vaultId` that ended without a verdict.
 *
 * Counts `failed` ONLY, not `retrying`. A retrying job has not finished failing — it will most
 * likely succeed on a later attempt, and counting it would make this caveat flap between runs for
 * a vault that is fine. `failed` is terminal: the queue is done with it, so the gap it represents
 * is permanent until someone requeues. An honest caveat needs the number that will still be true
 * tomorrow.
 *
 * Returns zero rather than throwing when `jobs` is absent. The same guard `synthesis.ts` already
 * applies to `contradictions` — this runs inside a scheduled job whose purpose is synthesis, and a
 * missing queue table should degrade the caveat, not kill the pass.
 */
export function contradictionCoverage(db: Database, vaultId: string): ContradictionCoverage {
  const present = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
    .get() as { x: number } | undefined;
  if (!present) return NO_COVERAGE_LOSS;

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE type = 'contradiction' AND state = 'failed'
          AND json_extract(payload, '$.vaultId') = ?`,
    )
    .get(vaultId) as { n: number } | undefined;
  return { deadLettered: row?.n ?? 0 };
}

/**
 * The reader-visible sentence, or "" when nothing was lost.
 *
 * Phrased on `lineage.ts`'s `unjudgedCaveat` precedent (THE-735, #705), which solved this same
 * inferred-vs-observed problem for citations. The load-bearing clause is the second one: it states
 * what the ABSENCE means, because a reader who sees a short contradiction list will otherwise treat
 * it as a complete one. Saying only "159 checks failed" invites "so what"; saying what the list can
 * no longer be relied on to prove is the part that changes a conclusion.
 */
export function coverageCaveat(coverage: ContradictionCoverage): string {
  if (coverage.deadLettered <= 0) return "";
  const s = coverage.deadLettered === 1 ? "" : "s";
  return (
    `(COVERAGE GAP: ${coverage.deadLettered} contradiction check${s} for this vault ended with no ` +
    "verdict, so the list above is INCOMPLETE. Absence of a contradiction here is absence of " +
    "EVIDENCE, not evidence that the material is uncontested.)"
  );
}
