// GH #1477: the OAuth family-revocation counter. Split out of registry.ts, which sits at biome's
// per-file line cap; MetricsRecorder owns one instance and delegates, same as MaintenanceCounters.
import { Counter, type Registry } from "@prometheus-io/client";
import type { FamilyRevocationReason } from "../auth/family-revocation-telemetry";

export class FamilyRevocationCounters {
  private readonly revoked: Counter<string>;

  constructor(registers: Registry[]) {
    this.revoked = new Counter({
      name: "reliquary_tc_auth_family_revocations_total",
      // A replayed authorization code or refresh token revokes its whole family on sight (RFC 9700
      // section 4.14) — correct, and also a one-request kill switch on a client's session, so the
      // reuse reasons are the theft/DoS signal to alert on. No `vault` label: the authorization
      // server is process-wide, the auth_rejections_total precedent.
      help: "OAuth grant-family revocations by the bundled authorization server, by reason. authorization_code_reuse, refresh_token_reuse and refresh_token_foreign mean a presented credential was a replay (or minted under a replaced server secret) and its whole family was revoked on sight (RFC 9700 section 4.14): any growth is worth investigating, since one leaked credential is a one-request kill switch on the client's session. revoked_by_client (RFC 7009) and authorization_code_failed are the benign counterparts.",
      labelNames: ["reason"],
      registers,
    });
  }

  inc(reason: FamilyRevocationReason): void {
    this.revoked.inc({ reason });
  }
}
