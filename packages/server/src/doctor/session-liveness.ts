// THE-1108: sessions.liveness — is any EXPLICIT (start_session) session stuck open past the
// resolver's own bound?
//
// `sessions.windowSeconds` already stops `activeSessionFor` (workspace/sessions.ts) from attaching
// NEW dispatch traffic to an explicit session once it is this old; it does not CLOSE the row — only
// `end_session`, or the separate `sessions.maxExplicitLifetimeSeconds` sweep, does that. This check
// makes the in-between state ("stopped correlating, still technically open") visible offline, the
// same way `entrypoints.liveness`/`derived.liveness` surface a condition nothing else reports.
//
// Split into its own module rather than appended to checks.ts, same reasoning as
// capture-location.ts/entrypoints.ts: its own probe shape, no shared state with the other checks.
import type { Check, CheckResult, CheckStatus } from "./types";

export interface SessionLivenessProbe {
  /** Open EXPLICIT sessions already older than `windowSeconds`. */
  staleExplicit: number;
  /** Age of the oldest one in ms, or null when `staleExplicit` is 0. Never coerced to 0 — see
   *  workspace/sessions.ts's `staleExplicitSessionSummary`. */
  oldestAgeMs: number | null;
  /** Principal of the oldest one, or null when `staleExplicit` is 0 or that row predates
   *  `principal` being recorded at all (pre-20260804_001). */
  oldestPrincipal: string | null;
}

export interface SessionLivenessView {
  /** config.sessions.windowSeconds — the same bound the resolver applies, so the check cannot
   *  report a different threshold than the one actually enforced. */
  windowSeconds: number;
  /** Probe-only: reading workspace_sessions means opening cache.db, same as every other
   *  store-touching view in this directory (derivedTables, entryPoints, ...). Absent -> the
   *  default (non---probe) doctor run reports "not probed" rather than a false "ok". */
  probe?: () => SessionLivenessProbe;
}

/**
 * sessions.liveness — WARNING, never FAIL: a stuck-open explicit session breaks no request in
 * flight (see `closeExpiredExplicitSessions`'s own comment on why there is deliberately no
 * in-flight guard there either) — what it costs is a caller who forgot `end_session`, which is an
 * operational nudge, not an outage.
 */
export function sessionLivenessCheck(view: SessionLivenessView): Check {
  return {
    id: "sessions.liveness",
    category: "runtime",
    run: (): CheckResult => {
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: "session liveness (not probed): run `doctor --probe` to read workspace_sessions",
          details: { sessions: "not probed" },
        };
      }
      const { staleExplicit, oldestAgeMs, oldestPrincipal } = view.probe();
      if (staleExplicit === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: `session liveness: no explicit session older than windowSeconds (${view.windowSeconds}s)`,
          details: { staleExplicit: "0" },
        };
      }
      const oldestDays = ((oldestAgeMs ?? 0) / 86_400_000).toFixed(1);
      return {
        status: "warning" as CheckStatus,
        summary: `session liveness: ${staleExplicit} explicit session(s) older than windowSeconds (${view.windowSeconds}s), oldest ${oldestDays}d`,
        details: {
          staleExplicit: String(staleExplicit),
          ...(oldestAgeMs !== null ? { oldestAgeMs: String(oldestAgeMs) } : {}),
          ...(oldestPrincipal !== null ? { oldestPrincipal } : {}),
        },
        issues: [
          `${staleExplicit} explicit session(s) (opened by start_session, never end_session'd) are ` +
            "older than windowSeconds — dispatch has already stopped attaching new traffic to them " +
            "(THE-1108), but the row itself stays open until end_session, or until " +
            "sessions.maxExplicitLifetimeSeconds elapses and the maintenance sweep closes it.",
        ],
        remediation:
          "Call end_session for the owning caller if the session is actually finished, or leave it — " +
          "the maintenance sweep closes it once sessions.maxExplicitLifetimeSeconds elapses.",
      };
    },
  };
}
