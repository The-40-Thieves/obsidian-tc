// Audit job — THE-233 W-WORKERS, collapses kb-audit-worker into a local plane job. The KMS
// worker ran six Supabase RPC health checks; the obsidian-tc-applicable subset is ported as
// plain SQLite queries over the chunk store. The vendor-KB-specific checks (kb null embeds,
// stale MCP domains) are dropped — that data model is not in the converged vault-centric tree.
import type { Database } from "../../db/types";
import type { Job, JobContext, JobResult } from "../plane";

/** Per-vault breakdown of the two health checks below (THE-606). */
export interface VaultAuditCounts {
  vault_id: string;
  null_embeddings: number;
  duplicate_chunk_positions: number;
}

export interface AuditReport {
  vault_null_embeddings: number;
  duplicate_chunk_positions: number;
  /** THE-606: the two totals above are GLOBAL sums across every vault -- this is the per-vault
   *  breakdown an operator actually needs to tell "vault A is unhealthy" from "vault B is". */
  per_vault: VaultAuditCounts[];
  details: Record<string, unknown>;
}

interface CountRow {
  c: number;
}

interface VaultCountRow {
  vault_id: string;
  c: number;
}

/** Run the health checks over the chunk store (pure read + a single report insert). */
export function runAudit(
  db: Database,
  now: () => number,
): { report: AuditReport; hasIssues: boolean } {
  const nullEmb = db
    .prepare(
      `SELECT COUNT(*) AS c FROM chunks c
       WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.is_active = 1)`,
    )
    .get() as CountRow;
  const dupePositions = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT vault_id, path, chunk_index FROM chunks
         GROUP BY vault_id, path, chunk_index HAVING COUNT(*) > 1
       )`,
    )
    .get() as CountRow;

  const nullEmbByVault = db
    .prepare(
      `SELECT vault_id, COUNT(*) AS c FROM chunks c
       WHERE NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.is_active = 1)
       GROUP BY vault_id`,
    )
    .all() as VaultCountRow[];
  const dupePositionsByVault = db
    .prepare(
      `SELECT vault_id, COUNT(*) AS c FROM (
         SELECT vault_id, path, chunk_index FROM chunks
         GROUP BY vault_id, path, chunk_index HAVING COUNT(*) > 1
       )
       GROUP BY vault_id`,
    )
    .all() as VaultCountRow[];
  const perVault = new Map<string, VaultAuditCounts>();
  const vaultRow = (vaultId: string): VaultAuditCounts => {
    let row = perVault.get(vaultId);
    if (!row) {
      row = { vault_id: vaultId, null_embeddings: 0, duplicate_chunk_positions: 0 };
      perVault.set(vaultId, row);
    }
    return row;
  };
  for (const r of nullEmbByVault) vaultRow(r.vault_id).null_embeddings = r.c;
  for (const r of dupePositionsByVault) vaultRow(r.vault_id).duplicate_chunk_positions = r.c;

  const report: AuditReport = {
    vault_null_embeddings: nullEmb.c,
    duplicate_chunk_positions: dupePositions.c,
    per_vault: [...perVault.values()],
    details: {},
  };
  const totalIssues = report.vault_null_embeddings + report.duplicate_chunk_positions;
  const summary =
    totalIssues === 0
      ? "All checks clean."
      : `${report.vault_null_embeddings} null embeds; ${report.duplicate_chunk_positions} duplicate positions`;

  db.prepare(
    "INSERT INTO audit_reports (report_type, created_at, has_issues, summary, report) VALUES ('kb_health', ?, ?, ?, ?)",
  ).run(now(), totalIssues > 0 ? 1 : 0, summary, JSON.stringify(report));

  return { report, hasIssues: totalIssues > 0 };
}

export const auditJob: Job = {
  name: "audit",
  async run(ctx: JobContext): Promise<JobResult> {
    const { report, hasIssues } = runAudit(ctx.db, ctx.now);
    return { ok: true, detail: { ...report, has_issues: hasIssues } };
  },
};
