// THE-521 — doctor report types.
//
// Schema mirrors the merged `codex doctor --json` (codex-rs/cli/src/doctor.rs): camelCase wire keys,
// a snake_case status enum, and `checks` as an OBJECT keyed by dotted stable id so support tooling
// can read checks["auth.maxAge"] without scanning an array. The ids are a stable contract for
// support/observability tooling; they are NOT a CI-gating contract (Codex's evidence supports the
// former, not the latter).

export type CheckStatus = "ok" | "warning" | "fail";

/** What a check produces. The framework adds id/category/durationMs around this. `details` is
 *  map<string, string | string[]> — structured but flat, matching codex's shape, not free JSON. */
export interface CheckResult {
  status: CheckStatus;
  summary: string;
  details?: Record<string, string | string[]>;
  issues?: string[];
  notes?: string[];
  remediation?: string;
}

/** An independently testable health probe. `run` may be sync or async; if it throws, the framework
 *  records a fail rather than letting the whole run crash — a doctor that dies on one bad check is
 *  useless exactly when it is needed most. */
export interface Check {
  id: string;
  category: string;
  run: (ctx: DoctorContext) => CheckResult | Promise<CheckResult>;
}

/** Injected environment for a run: version string, a clock for `generatedAt`, and a monotonic source
 *  for durations. Injecting both keeps the framework deterministic under test. */
export interface DoctorContext {
  serverVersion: string;
  /** Wall-clock ISO timestamp for the report. */
  now?: () => string;
  /** Monotonic milliseconds for per-check duration. Defaults to performance.now(). */
  monotonic?: () => number;
}

/** A check as it appears in the report: the result plus framework-assigned id/category/duration. */
export interface DoctorCheck extends CheckResult {
  id: string;
  category: string;
  durationMs: number;
}

/** The versioned envelope. This is the PRIMARY return value; human text is rendered from it. */
export interface DoctorReport {
  schemaVersion: number;
  generatedAt: string;
  overallStatus: CheckStatus;
  serverVersion: string;
  checks: Record<string, DoctorCheck>;
}
