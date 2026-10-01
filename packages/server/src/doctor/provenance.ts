// provenance.chain (doctor) — is the signed write-provenance chain in cache.db intact? Offline and
// read-only; the view is built by `inspectProvenance`, the same verification `obsidian-tc provenance
// verify` runs.
//
// FAIL on any sign the evidence was altered (a changed record, a removed record, a removed last
// record, a bad or unknown-key signature). WARN when records exist with no signature: the chain is
// then self-consistent but anyone with file access could have rewritten all of it. A fresh install
// with no records and no EdDSA key is only a note: nothing is wrong yet, and the note says what
// would make the next record signed. WARN too when a committed write left no record (fail-open).
import type { Check, CheckResult } from "./types";

export interface ProvenanceVaultView {
  vault: string;
  records: number;
  signed: number;
  unsigned: number;
  problems: Array<{ code: string; seq?: number; detail: string }>;
}

export interface ProvenanceView {
  /** `provenance.enabled`. */
  enabled: boolean;
  registryState: "uninitialised" | "ok" | "lost";
  registryDetail?: string;
  /** An active EdDSA registry key exists, so the next record is signed. */
  signingKeyActive: boolean;
  vaults: ProvenanceVaultView[];
  /** Recording faults in event_log (see ProvenanceInspection.faults). */
  faults?: { omitted: number; headUntrusted: number };
  /** Why the chain could not be read at all (an unreadable or unmigrated cache.db). */
  unreadable?: string;
}

const UNSIGNED_CODES = new Set(["unsigned", "head_unsigned"]);
const MAX_ISSUES = 10;

export function provenanceCheck(view: ProvenanceView): Check {
  return {
    id: "provenance.chain",
    category: "config",
    run: (): CheckResult => {
      const records = view.vaults.reduce((n, v) => n + v.records, 0);
      const details = {
        enabled: String(view.enabled),
        signingKeyActive: String(view.signingKeyActive),
        vaults: view.vaults.map((v) => `${v.vault}: ${v.records} records (${v.signed} signed)`),
      };
      if (view.unreadable !== undefined) {
        return {
          status: "warning",
          summary: "write provenance: the chain could not be read, so it is unverified",
          details,
          issues: [view.unreadable],
          remediation: "Run `obsidian-tc provenance verify` to see the same error directly.",
        };
      }
      if (view.registryState === "lost" && records > 0) {
        return {
          status: "warning",
          summary: `write provenance: ${records} records cannot be verified, the auth registry is lost`,
          details,
          ...(view.registryDetail !== undefined ? { issues: [view.registryDetail] } : {}),
          remediation:
            "Restore auth.db from backup: without the registry's public keys no signature can be checked.",
        };
      }
      const tampered = view.vaults.flatMap((v) =>
        v.problems
          .filter((p) => !UNSIGNED_CODES.has(p.code))
          .map(
            (p) =>
              `vault ${v.vault}: ${p.seq === undefined ? "head" : `seq ${p.seq}`} ${p.code}: ${p.detail}`,
          ),
      );
      if (tampered.length > 0) {
        return {
          status: "fail",
          summary: `write provenance: the chain FAILED verification (${tampered.length} problem${tampered.length === 1 ? "" : "s"})`,
          details,
          issues: tampered.slice(0, MAX_ISSUES),
          remediation:
            "Run `obsidian-tc provenance verify` for the full list. A failed chain means records were changed, removed or forged after they were written: treat cache.db as untrusted for attribution.",
        };
      }
      // Recording is fail-open, so an omitted record is otherwise indistinguishable from "no write
      // happened": the chain verifies and is incomplete. Never ok while any is on file.
      const omitted = view.faults?.omitted ?? 0;
      if (omitted > 0) {
        return {
          status: "warning",
          summary: `write provenance: ${omitted} committed write${omitted === 1 ? "" : "s"} left no record (a recording fault); the chain verifies but is incomplete`,
          details,
          remediation:
            "Find the cause in the server log (`[provenance] ...`) and the obsidian_tc_provenance_faults_total counter. The events age out with event_log retention.",
        };
      }
      const unsigned = view.vaults.reduce((n, v) => n + v.unsigned, 0);
      if (unsigned > 0) {
        return {
          status: "warning",
          summary: `write provenance: ${unsigned} of ${records} records are unsigned, so the chain alone cannot prove they were not rewritten`,
          details,
          remediation:
            "Create an EdDSA signing key with `obsidian-tc auth rotate-key --alg EdDSA` on a jwt/oidc HTTP server. Records written from then on are signed; `provenance verify --allow-unsigned` accepts the earlier ones.",
        };
      }
      const notes: string[] = [];
      if (view.enabled && !view.signingKeyActive) {
        notes.push(
          "no active EdDSA signing key: new records are written unsigned (auth rotate-key --alg EdDSA, jwt/oidc HTTP server)",
        );
      }
      return {
        status: "ok",
        summary: !view.enabled
          ? "write provenance: disabled (provenance.enabled is false)"
          : records === 0
            ? "write provenance: enabled, no records yet"
            : `write provenance: ${records} records verified`,
        details,
        ...(notes.length > 0 ? { notes } : {}),
      };
    },
  };
}
