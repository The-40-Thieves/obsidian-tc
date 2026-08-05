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
  | "unparseable";

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
export function exitCodeFor(summary: RerunSummary): 0 | 1 | 2 {
  if (summary.runnable === 0) return 2;
  if (summary.diverged > 0) return 1;
  return 0;
}
