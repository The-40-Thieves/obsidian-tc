// auth.family-revocations — OAuth grant-family revocations over a recent window, content-free.
//
// Reads the `auth_family_revoked` rows family-revocation-telemetry.ts's sink writes (GH #1477).
// A replayed authorization code or refresh token revokes the whole family on sight (RFC 9700
// section 4.14) — correct, but a leaked credential is then a one-request kill switch on the
// client's session, and the revocation was previously visible only on the process's stderr. This
// check is the operator surface for it; `obsidian_tc_auth_family_revocations_total` is the
// continuous one.
//
// WARNING, never FAIL: a reuse-driven revocation means the defence WORKED — it is the smell of a
// leaked or mishandled credential, not a broken server. Operator-initiated grant revocations are
// not here: they already audit as auth_grant_revoked / auth_credentials_reset.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type FamilyRevocationReason,
  REUSE_DRIVEN_REASONS,
  readFamilyRevocations,
} from "../auth/family-revocation-telemetry";
import { openDatabase } from "../db/open";
import type { Check, CheckResult } from "./types";

/** The recent window doctor reads (still bounded by `eventLogDays` retention). */
export const FAMILY_REVOCATION_WINDOW_HOURS = 24;

export interface FamilyRevocationsProbe {
  total: number;
  byReason: Partial<Record<FamilyRevocationReason, number>>;
  latest?: {
    ts: number;
    reason: FamilyRevocationReason;
    clientId: string | null;
    accessTokens: number;
  };
  /** Set when event_log could not be read: reported as a warning, never as "no revocations". */
  error?: string;
}

export interface FamilyRevocationsView {
  /** The recent window the probe read, in hours (also bounded by `eventLogDays` retention). */
  windowHours: number;
  /** Probe-only: reading event_log means opening cache.db, like every store-touching view. */
  probe?: () => FamilyRevocationsProbe;
}

function revocationDetails(probed: FamilyRevocationsProbe, window: string): Record<string, string> {
  const details: Record<string, string> = { window, revocations: String(probed.total) };
  for (const [reason, n] of Object.entries(probed.byReason)) {
    details[`reason.${reason}`] = String(n);
  }
  if (probed.latest !== undefined) {
    details.latest =
      `${probed.latest.reason} client=${probed.latest.clientId ?? "unknown"} ` +
      `at ${new Date(probed.latest.ts).toISOString()} ` +
      `(${probed.latest.accessTokens} access token(s) revoked with it)`;
  }
  return details;
}

export function familyRevocationsCheck(view: FamilyRevocationsView): Check {
  return {
    id: "auth.family-revocations",
    category: "security",
    run: (): CheckResult => {
      if (!view.probe) {
        return {
          status: "ok",
          summary:
            "OAuth family revocations (not probed): run `doctor --probe` to read the recent ones",
          details: { familyRevocations: "not probed" },
        };
      }
      const probed = view.probe();
      if (probed.error !== undefined) {
        return {
          status: "warning",
          summary: `OAuth family revocations could not be read: ${probed.error}`,
          details: { familyRevocations: "unreadable" },
        };
      }
      const window = `${view.windowHours}h`;
      const details = revocationDetails(probed, window);
      if (probed.total === 0) {
        return {
          status: "ok",
          summary: `no OAuth family revocations in the last ${window}`,
          details,
        };
      }
      const reuse = Object.entries(probed.byReason)
        .filter(([reason]) => REUSE_DRIVEN_REASONS.has(reason as FamilyRevocationReason))
        .reduce((n, [, count]) => n + (count ?? 0), 0);
      if (reuse === 0) {
        return {
          status: "ok",
          summary: `${probed.total} OAuth family revocation(s) in the last ${window}, none reuse-driven`,
          details,
        };
      }
      const latest = probed.latest;
      return {
        status: "warning",
        summary: `${reuse} reuse-driven OAuth family revocation(s) of ${probed.total} in the last ${window}`,
        details,
        issues: [
          latest === undefined
            ? `${reuse} reuse-driven revocation(s): a presented credential was a replay`
            : `latest: ${latest.reason} (client ${latest.clientId ?? "unknown"}) at ${new Date(latest.ts).toISOString()}, revoking ${latest.accessTokens} access token(s) with the family`,
        ],
        remediation:
          "A reused authorization code or refresh token revokes its whole family on sight (RFC 9700 section 4.14): the defence worked, but one leaked credential is a one-request kill switch on that client's session. If no client of yours retried with a stale token, treat the credential as leaked — revoke the grant (`obsidian-tc auth as grants list`, then `revoke`) and have the client re-consent. `obsidian_tc_auth_family_revocations_total` counts these continuously; event_log keeps the rows under event_type=auth_family_revoked.",
      };
    },
  };
}

/** The `doctor --probe` reader: family revocations over the last `windowHours`. Never throws; a
 *  missing cache.db reports none, an unreadable one reports `error`. */
export async function probeFamilyRevocations(
  cacheDir: string,
  busyTimeoutMs: number,
  opts: { windowHours: number; now?: number },
): Promise<FamilyRevocationsProbe> {
  const path = join(cacheDir, "cache.db");
  if (!existsSync(path)) return { total: 0, byReason: {} };
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(path, busyTimeoutMs, { readonly: true });
    const nowMs = opts.now ?? Date.now();
    return readFamilyRevocations(db, { sinceMs: nowMs - opts.windowHours * 3_600_000 });
  } catch (e) {
    return { total: 0, byReason: {}, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      db?.close?.();
    } catch {
      // best-effort close: the outcome is already decided, a failing close changes nothing
    }
  }
}
/** The doctor view: the probe runs only under `doctor --probe` (it opens cache.db), so a static
 *  run's view carries no probe and the check reports "not probed". */
export async function familyRevocationsView(
  cacheDir: string,
  busyTimeoutMs: number,
  probe: boolean | undefined,
): Promise<FamilyRevocationsView> {
  const windowHours = FAMILY_REVOCATION_WINDOW_HOURS;
  if (!probe) return { windowHours };
  const probed = await probeFamilyRevocations(cacheDir, busyTimeoutMs, { windowHours });
  return { windowHours, probe: () => probed };
}
