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
