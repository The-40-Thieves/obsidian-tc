// GH #1477: telemetry for OAuth grant-family revocations. A replayed authorization code or refresh
// token revokes the whole family on sight (RFC 9700 section 4.14) — that is the right behaviour,
// but it is also a one-request kill switch on a client's session, and until now it was visible only
// as a line on the process's stderr. This module is the one place the signal is defined:
//
//  - `FamilyRevocationEvent`, reported by the revocation seam (revokeFamily in as-grants.ts)
//    through the `onFamilyRevoked` hook on AsRouteDeps;
//  - `familyRevocationSink`, the production hook: one Prometheus counter increment
//    (`obsidian_tc_auth_family_revocations_total`, labelled by the bounded `reason` union below)
//    and one content-free row in cache.db's event_log (`auth_family_revoked`: ts, client_id in
//    `caller`, reason in `error_code`, revoked access-token count in `result_size` — never a code,
//    token, verifier or hash);
//  - `readFamilyRevocations`, the reader doctor's `auth.family-revocations` check probes.
//
// The sink is FAIL-OPEN on the audit row, exactly like dispatch's audit writes: telemetry must
// never break the revocation path. A lost row moves `obsidian_tc_audit_write_failed_total` instead
// (the counter increment above it already landed, so the metric never depends on the store).
import { writeEvent } from "../audit";
import type { Database } from "../db/types";

/** The slice of MetricsRecorder the sink uses. Structural, so this module never imports the
 *  registry while the registry imports the reason union from here — no import cycle. */
export interface FamilyRevocationMetrics {
  readonly familyRevocations: { inc(reason: FamilyRevocationReason): void };
  incAuditWriteFailed(vault: string, tool: string): void;
}

/** The `reason` label of the counter and the `error_code` of the audit row: bounded by
 *  construction. Every producer is a literal at a revokeFamily call site; the routes' hook
 *  parameter is typed against this union, so a new series means widening it here first. */
export const FAMILY_REVOCATION_REASONS = [
  "authorization_code_reuse",
  "authorization_code_failed",
  "refresh_token_reuse",
  "refresh_token_foreign",
  "revoked_by_client",
] as const;
export type FamilyRevocationReason = (typeof FAMILY_REVOCATION_REASONS)[number];

/** The reasons a PRESENTED credential killed the family: a replay past the grace window, or a
 *  token minted under a replaced server secret. These are the theft / cheap-DoS signal the doctor
 *  check warns on; `authorization_code_failed` (the exchange's own store failed) and
 *  `revoked_by_client` are the benign counterparts. Operator grant revocations are not here at
 *  all — they already audit as `auth_grant_revoked` / `auth_credentials_reset`. */
export const REUSE_DRIVEN_REASONS: ReadonlySet<FamilyRevocationReason> = new Set([
  "authorization_code_reuse",
  "refresh_token_reuse",
  "refresh_token_foreign",
]);

export interface FamilyRevocationEvent {
  reason: FamilyRevocationReason;
  /** The OAuth client the revoked family belonged to (proved at the route), or null. */
  clientId: string | null;
  /** Access tokens revoked with the family (the ones still recorded; expired ones are swept). */
  accessTokens: number;
  /** Epoch ms of the revocation. */
  at: number;
}

/** What AsRouteDeps carries and revokeFamily reports through. */
export type FamilyRevocationHook = (event: FamilyRevocationEvent) => void;

/** `event_log.event_type` of the audit row. */
export const FAMILY_REVOKED_EVENT = "auth_family_revoked";

/**
 * The `telemetry` argument `revokeFamily` takes, built from the route's hook and the client the
 * request was proved to belong to. Undefined when nothing is wired (unit tests of the store), so
 * the revocation path carries no reporter of its own.
 */
export function familyRevocationTelemetry(
  hook: FamilyRevocationHook | undefined,
  clientId: string | null,
): { clientId: string | null; hook: FamilyRevocationHook } | undefined {
  return hook === undefined ? undefined : { clientId, hook };
}

/** The production hook: count it, then record it. Fail-open on the row — see the header. */
export function familyRevocationSink(deps: {
  /** cache.db, whose event_log holds the row (retention: observability.retention.eventLogDays). */
  db: Database;
  metrics?: FamilyRevocationMetrics | undefined;
}): FamilyRevocationHook {
  return (e) => {
    deps.metrics?.familyRevocations.inc(e.reason);
    try {
      writeEvent(deps.db, {
        ts: e.at,
        vault_id: null,
        tool_name: null,
        caller: e.clientId,
        duration_ms: null,
        result_size: e.accessTokens,
        status: "ok",
        error_code: e.reason,
        args_hash: null,
        event_type: FAMILY_REVOKED_EVENT,
      });
    } catch (err) {
      deps.metrics?.incAuditWriteFailed("auth", "family_revocation");
      process.stderr.write(
        `[as] family-revocation audit event could not be written: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };
}

export interface FamilyRevocationStats {
  total: number;
  byReason: Partial<Record<FamilyRevocationReason, number>>;
  latest?: {
    ts: number;
    reason: FamilyRevocationReason;
    clientId: string | null;
    accessTokens: number;
  };
}

/** The reader behind doctor's probe: the family revocations of the window, counted by reason. */
export function readFamilyRevocations(
  db: Database,
  { sinceMs }: { sinceMs: number },
): FamilyRevocationStats {
  const byReason: Partial<Record<FamilyRevocationReason, number>> = {};
  let total = 0;
  for (const row of db
    .prepare(
      `SELECT error_code AS reason, COUNT(*) AS n FROM event_log
        WHERE event_type = ? AND ts >= ? GROUP BY error_code`,
    )
    .all(FAMILY_REVOKED_EVENT, sinceMs) as Array<{ reason: FamilyRevocationReason; n: number }>) {
    byReason[row.reason] = row.n;
    total += row.n;
  }
  const latest = db
    .prepare(
      `SELECT ts, error_code AS reason, caller, COALESCE(result_size, 0) AS accessTokens
         FROM event_log WHERE event_type = ? AND ts >= ? ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(FAMILY_REVOKED_EVENT, sinceMs) as
    | { ts: number; reason: FamilyRevocationReason; caller: string | null; accessTokens: number }
    | undefined;
  return {
    total,
    byReason,
    ...(latest === undefined
      ? {}
      : {
          latest: {
            ts: latest.ts,
            reason: latest.reason,
            clientId: latest.caller,
            accessTokens: latest.accessTokens,
          },
        }),
  };
}
