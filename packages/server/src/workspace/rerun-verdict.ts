// THE-645 item 3 — is re-issuing this recorded call FAITHFUL?
//
// Pure by design: six branches, no dependencies, so it is testable without a vault fixture.
//
// DEFAULT-DENY. Every verdict other than `runnable` is a way a re-run that reported success would
// have been silently wrong — writing `[REDACTED]` into a note, dispatching `{}` because the args
// field was absent, or "repairing" JSON that was cut mid-string. A record that does not positively
// satisfy the capture contract is refused.
import type { TraceRecord } from "./sessions";

export type RerunVerdict =
  | "runnable"
  | "no_capture"
  | "redacted"
  | "truncated"
  | "skipped_mutating"
  | "unparseable"
  // THE-738: rerun ITSELF declined this call — the sandbox stripped the plugin bridge, or the
  // scope set this runner grants does not cover the tool. Distinct from `diverged` on purpose:
  // `diverged` must mean VAULT STATE MOVED, which is the only thing worth alerting on. Folding a
  // self-inflicted refusal into it made every read-only m4 bridge tool under --sandbox, and every
  // admin: call in observe mode, report as a divergence and flip the exit code to 1.
  | "refused_by_policy";

export interface ClassifiedRecord {
  verdict: RerunVerdict;
  /** The parsed arguments, ONLY for `runnable`. Null on every refusal — there is no partial
   *  credit, and a caller cannot accidentally dispatch a refused record's payload. */
  args: Record<string, unknown> | null;
  /** Operator-facing reason. Empty for `runnable`. */
  reason: string;
}

const REFUSE = (verdict: RerunVerdict, reason: string): ClassifiedRecord => ({
  verdict,
  args: null,
  reason,
});

/**
 * Classify ONE trace record. `skipped_mutating` is never produced here — that verdict is
 * dispatch's ruling under a read-only ACL, recorded after the fact, not a prediction this
 * function makes. See rerun.ts.
 */
export function classifyRecord(rec: TraceRecord): ClassifiedRecord {
  if (rec.args === undefined)
    return REFUSE(
      "no_capture",
      "no arguments were captured for this call — `sessions.traceContent` was off when the session was recorded",
    );
  if (rec.args_scan === "truncated")
    return REFUSE(
      "truncated",
      "arguments were cut at the capture size cap; the JSON is incomplete and repairing it would be invention",
    );
  if (typeof rec.args_scan === "string" && rec.args_scan.startsWith("redacted:"))
    return REFUSE(
      "redacted",
      `secrets were scrubbed from the arguments (${rec.args_scan}) — re-issuing would send the literal [REDACTED] placeholder`,
    );
  if (rec.args_scan !== "clean")
    return REFUSE(
      "unparseable",
      "record does not satisfy the capture contract: `args` present without `args_scan: clean`",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(rec.args);
  } catch {
    return REFUSE("unparseable", "captured arguments are not valid JSON (torn or corrupt line)");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return REFUSE("unparseable", "captured arguments are not a JSON object");
  return { verdict: "runnable", args: parsed as Record<string, unknown>, reason: "" };
}

/** What dispatch reported, on the recorded run and on this one. `Status` is
 *  `"ok" | "error" | "skipped"` (mcp/registry/types.ts:229). */
export interface CallOutcome {
  status?: string;
  result_size?: number;
  duration_ms?: number;
  error_code?: string;
}

export interface RerunRecord {
  seq: number;
  ts: number;
  tool: string;
  caller: string | null;
  verdict: RerunVerdict;
  reason: string;
  recorded: CallOutcome;
  /** Null for every verdict except `runnable` — a refused record was never dispatched. */
  replayed: CallOutcome | null;
  divergence: "none" | "status" | "error_code";
}

export interface RerunSummary {
  total: number;
  runnable: number;
  diverged: number;
  byVerdict: Record<RerunVerdict, number>;
}

const ZERO: Record<RerunVerdict, number> = {
  runnable: 0,
  no_capture: 0,
  redacted: 0,
  truncated: 0,
  skipped_mutating: 0,
  unparseable: 0,
  refused_by_policy: 0,
};

export function summarizeRerun(records: RerunRecord[]): RerunSummary {
  const byVerdict = { ...ZERO };
  let diverged = 0;
  for (const r of records) {
    byVerdict[r.verdict] += 1;
    if (r.divergence !== "none") diverged += 1;
  }
  return { total: records.length, runnable: byVerdict.runnable, diverged, byVerdict };
}

/**
 * 0 = ran, nothing moved. 1 = ran, something moved (the regression signal). 2 = NOTHING was
 * runnable.
 *
 * 2 existing at all is the point. The happy path and the total-refusal path both terminate without
 * errors, so without a distinct code "everything was refused" and "everything passed" are the same
 * observable outcome — and while `sessions.traceContent` is off, total refusal is the only
 * reachable path. Conditions are disjoint and evaluated in this order.
 */
/**
 * THE-738 — exit codes, and why there are four.
 *
 *   0  ran, nothing moved
 *   1  DIVERGENCE FOUND — the vault answered differently
 *   2  nothing was runnable (no verdict could be formed)
 *   3  the command did not run (unknown session, --vault mismatch, staging failure)
 *
 * 3 exists because 1 used to mean two different things. A thrown error reached `main()`'s catch,
 * which writes `fatal: ...` and also exits 1 — so a script gating on `$? -eq 1` could not tell
 * "the vault changed" from "the command never ran". Exit 2 was already minted to keep
 * total-refusal distinguishable from success; leaving this collision in place undercut the same
 * reasoning.
 */
export const RERUN_EXIT_OPERATIONAL = 3;

/**
 * A USAGE error — the operator named something that does not exist. Kept at exit 2 deliberately:
 * `prefetch.ts` already exits 2 for an unknown `--vault`, and an unknown vault was never part of
 * the exit-1 collision THE-738 exists to fix. Only throws that previously reached `main()`'s catch
 * (and so exited 1, indistinguishable from "the vault changed") get the new code 3.
 */
export class RerunUsageError extends Error {
  readonly exitCode = 2;
}

export function exitCodeFor(summary: RerunSummary): 0 | 1 | 2 {
  if (summary.runnable === 0) return 2;
  if (summary.diverged > 0) return 1;
  return 0;
}
