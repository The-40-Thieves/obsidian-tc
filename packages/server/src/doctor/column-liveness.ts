// derived.column-liveness (THE-720) — the half derived.liveness structurally cannot see.
//
// Its own module rather than more of checks.ts: that file is already comment-dense against biome's
// 700-line ceiling, and this is a self-contained second classifier. Re-exported from checks.ts so
// every existing importer of the doctor surface is unchanged.
import type { Check, CheckStatus } from "./types";

/**
 * One derived COLUMN's observed state.
 *
 * Deliberately NOT extra optional fields on `DerivedTableState`. The finding predicate is a
 * different one — a table is a finding at `rows === 0`, a column at `nonNull === 0` while
 * `rows > 0` — and overloading a single type would leave every existing derived.liveness assertion
 * ambiguous about which of the two it pins.
 */
export interface DerivedColumnState {
  /** "table.column", store-qualified when ambiguous (e.g. "experiential.chunk_retrievals.outcome"). */
  column: string;
  /** Rows in the OWNING TABLE. Zero means the table is the finding and this column cannot speak. */
  rows: number;
  /** Rows where the column is non-NULL. */
  nonNull: number;
  /** Distinct non-NULL values. One, with nonNull > 0, is a column written to a constant. */
  distinct: number;
  /** Same vocabulary as DerivedTableState.writer — see there for why the split is load-bearing. */
  writer: "enabled" | "on-demand" | "disabled" | "none";
  /** The lever: what would write this column, or why nothing does. Shown in remediation. */
  lever: string;
}

export interface DerivedColumnsView {
  /** Attached only under `--probe`; the default run stays offline and touches no store. */
  probe?: () => DerivedColumnState[];
}

/**
 * derived.column-liveness — is each signal-bearing column actually receiving values?
 *
 * `derived.liveness` classifies TABLES by row count, and that is structurally blind to the case
 * that motivated this check. `chunk_retrievals` held 97 rows for 18 days and reported `live` the
 * entire time while `outcome` and `feedback` were NULL on all 97 — the signal THE-641, THE-643 and
 * THE-644 all transform, dead, and invisible to every check in the system. `note_quality` is the
 * same shape from the other side: 1,151 rows, `quality_score` NULL on 1,111, and 36 of the 40
 * scored rows carrying an identical 0.30. **Row count passes; the distribution does not.**
 *
 * The classification discipline is inherited wholesale from derived.liveness — a check that warns
 * on correct behaviour gets muted, and is then worth nothing when it is finally right — and gains
 * two cases of its own:
 *
 *   rows = 0                              -> inconclusive (ok — derived.liveness owns this finding;
 *                                            repeating it per column turns one into five)
 *   nonNull > 0, distinct > 1             -> live          (ok)
 *   nonNull > 0, distinct = 1             -> CONSTANT      (reported, NOT warned)
 *   nonNull = 0, writer disabled          -> off           (ok — switched off, expected)
 *   nonNull = 0, writer on-demand         -> neverStamped  (reported, NOT warned)
 *   nonNull = 0, writer enabled           -> SILENT        (warning — configured, never wrote)
 *   nonNull = 0, writer none              -> UNWRITTEN     (warning — nothing can write it)
 *
 * `constant` is reported rather than warned on purpose. A column written to one value is as dead
 * as a NULL one for any consumer that ranks on it, but "every dispatch so far succeeded" is a
 * legitimately uniform column, and warning on it is exactly how this check would get muted. The
 * distinction needs a human, so it gets stated and not escalated.
 *
 * A warning, never a fail: a dead column breaks no request in flight. What it breaks is the belief
 * that a shipped signal is a working one.
 */
export function derivedColumnsCheck(view: DerivedColumnsView): Check {
  return {
    id: "derived.column-liveness",
    category: "retrieval",
    run: () => {
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: "derived columns (not probed): run `doctor --probe` to sample values",
          details: { liveness: "not probed" },
        };
      }
      const states = view.probe();
      if (states.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: "derived columns: no store to inspect",
          details: { liveness: "no store" },
        };
      }

      // Order matters: an empty table disqualifies its columns from every other bucket, so this
      // partition comes first and the rest only ever see columns whose table has rows.
      const inconclusive = states.filter((s) => s.rows === 0);
      const speaking = states.filter((s) => s.rows > 0);
      const written = speaking.filter((s) => s.nonNull > 0);
      const live = written.filter((s) => s.distinct > 1);
      const constant = written.filter((s) => s.distinct <= 1);
      const empty = speaking.filter((s) => s.nonNull === 0);
      const off = empty.filter((s) => s.writer === "disabled");
      const neverStamped = empty.filter((s) => s.writer === "on-demand");
      const silent = empty.filter((s) => s.writer === "enabled");
      const unwritten = empty.filter((s) => s.writer === "none");

      const details: Record<string, string | string[]> = {
        live: live.map((s) => `${s.column}=${s.nonNull}/${s.rows}`),
        off: off.map((s) => s.column),
      };
      // The scan's own size, always present. A spec that regresses to covering nothing would
      // otherwise report a confident, entirely green verdict about zero columns.
      if (inconclusive.length > 0) details.inconclusive = inconclusive.map((s) => s.column);
      if (constant.length > 0)
        details.constant = constant.map(
          (s) => `${s.column} (${s.nonNull} rows, ${s.distinct} distinct value)`,
        );
      if (neverStamped.length > 0) details.neverStamped = neverStamped.map((s) => s.column);
      if (silent.length > 0) details.silent = silent.map((s) => `${s.column} (${s.lever})`);
      if (unwritten.length > 0)
        details.unwritten = unwritten.map((s) => `${s.column} (${s.lever})`);

      const scanned = `${states.length} column${states.length === 1 ? "" : "s"} scanned`;
      if (silent.length === 0 && unwritten.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: `derived columns: ${scanned} — ${live.length} carrying values, ${constant.length} constant, ${off.length} off by config`,
          details,
        };
      }
      const issues = [
        ...silent.map(
          (s) =>
            `${s.column}: the table has ${s.rows} rows but this column is NULL on every one of them — its writer is ENABLED and has never stamped a value`,
        ),
        ...unwritten.map(
          (s) => `${s.column}: ${s.rows} rows and no code path writes this column at all`,
        ),
      ];
      return {
        status: "warning" as CheckStatus,
        summary: `derived columns: ${scanned} — ${silent.length} never stamped, ${unwritten.length} with no writer (${live.length} carrying values)`,
        details,
        issues,
        remediation:
          "A populated table with a dead column is the failure mode a row count cannot see: every consumer of that column is computing over NULLs and returning a well-formed, meaningless answer. For each column under `silent`, the named lever is what should be writing it — confirm the producer is genuinely exercised rather than merely reachable. For `unwritten`, there is no writer to enable. Columns under `constant` are not warnings but deserve a look: a signal pinned to one value discriminates nothing, which is indistinguishable from absent for anything that ranks on it.",
      };
    },
  };
}
