// audit.kbHealth (THE-722) — the read surface for a producer that had none.
//
// `plane/jobs/audit.ts` writes a kb_health report on every audit pass: 301 rows in production
// across ~40 hours, one roughly every 8 minutes, none of them readable by anyone. Both liveness
// checks reported `audit_reports` as `live` — it has rows — which is precisely the blind spot
// check:table-readers exists to catch.
//
// THE FIX FOR AN ORPHANED PRODUCER IS TO BUILD THE READER. Deleting the writer would have been
// cheaper and would have destroyed the only vault-integrity signal the system collects: null
// embeddings (a chunk indexed but unsearchable) and duplicate chunk positions (an ingest bug that
// double-counts content). Those are exactly the faults nothing else in doctor looks for.
//
// Routing this through doctor rather than a new tool is deliberate: doctor already runs 6-hourly
// on a timer and every check id becomes `otc_doctor_check_status{check=...}` in Prometheus, so a
// report that was invisible becomes an alertable series without any new plumbing.
import type { Check, CheckStatus } from "./types";

/** Per-vault breakdown, mirroring audit.ts's VaultAuditCounts. */
export interface KbHealthVault {
  vault_id: string;
  null_embeddings: number;
  duplicate_chunk_positions: number;
}

export interface KbHealthProbe {
  /** Rows in audit_reports. Surfaced because the table has NO retention sweep — see the check. */
  totalReports: number;
  /** created_at of the newest report; undefined when the audit has never run. */
  latestAt?: number;
  now: number;
  hasIssues: boolean;
  summary: string;
  nullEmbeddings: number;
  duplicateChunkPositions: number;
  perVault: KbHealthVault[];
}

export interface KbHealthView {
  probe?: () => KbHealthProbe;
}

/**
 * Reports STALE after this long. The job writes roughly every 8 minutes, so six hours is ~45
 * missed passes — comfortably past a restart or a slow sweep, and well inside the 6-hourly doctor
 * cadence that will observe it.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * audit.kbHealth — is the vault's stored content actually intact, and is anything still checking?
 *
 * Two findings, deliberately separate because they have different fixes:
 *
 *   latest report has issues  -> WARNING naming the counts. Null embeddings mean chunks that are
 *                                indexed but unreachable by dense retrieval; duplicate positions
 *                                mean an ingest path counted the same content twice.
 *   reports stopped           -> WARNING. A clean report from three days ago reads exactly like a
 *                                healthy vault, which is how a dead checker stays unnoticed. The
 *                                staleness IS the finding, and it is about the JOB, not the vault.
 *
 * Never fails: an integrity finding breaks no request in flight. What it breaks is the belief that
 * the index covers what you think it covers.
 */
export function kbHealthCheck(view: KbHealthView): Check {
  return {
    id: "audit.kbHealth",
    category: "retrieval",
    run: () => {
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: "kb health (not probed): run `doctor --probe` to read the latest audit report",
          details: { kbHealth: "not probed" },
        };
      }
      const p = view.probe();
      if (p.totalReports === 0 || p.latestAt === undefined) {
        return {
          status: "ok" as CheckStatus,
          summary: "kb health: the audit job has not written a report yet",
          details: { kbHealth: "never run" },
        };
      }

      const ageMs = p.now - p.latestAt;
      const ageH = (ageMs / 3_600_000).toFixed(1);
      const stale = ageMs > STALE_AFTER_MS;
      const details: Record<string, string | string[]> = {
        reports: String(p.totalReports),
        latestAgeHours: ageH,
        verdict: p.summary,
      };
      if (p.perVault.length > 0)
        details.perVault = p.perVault.map(
          (v) =>
            `${v.vault_id}: ${v.null_embeddings} null embed(s), ${v.duplicate_chunk_positions} duplicate position(s)`,
        );

      const issues: string[] = [];
      if (p.hasIssues)
        issues.push(
          `vault integrity: ${p.nullEmbeddings} chunk(s) with no embedding, ${p.duplicateChunkPositions} duplicate chunk position(s) — indexed content that dense retrieval cannot reach, and content counted twice`,
        );
      if (stale)
        issues.push(
          `the audit job appears to have stopped: newest report is ${ageH}h old and it normally writes every few minutes. The vault was clean when last measured — this is a finding about the CHECKER, not the content`,
        );

      if (issues.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: `kb health: clean (${p.totalReports} report(s), newest ${ageH}h old)`,
          details,
        };
      }
      return {
        status: "warning" as CheckStatus,
        summary: `kb health: ${p.hasIssues ? "issues found" : "clean"}${stale ? ", reports stalled" : ""} (${p.totalReports} report(s), newest ${ageH}h old)`,
        details,
        issues,
        remediation:
          "Null embeddings: re-index the affected vault — those chunks exist in the store but no semantic query can reach them, so retrieval is silently incomplete rather than wrong. Duplicate chunk positions: an ingest path wrote the same position twice, which double-counts content in ranking. If instead the reports have STOPPED, the vault is not the problem — check that the plane is enabled and its job runner is alive (`plane.enabled`, and job_runs per THE-716). Note audit_reports has no retention sweep: it grows ~170 rows/day unpruned.",
      };
    },
  };
}
