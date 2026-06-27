// Audit job — THE-233 W-WORKERS, collapses kb-audit-worker into a local plane job. The KMS
// worker ran six Supabase RPC health checks; the obsidian-tc-applicable subset is ported as
// plain SQLite queries over the chunk store. The vendor-KB-specific checks (kb null embeds,
// stale MCP domains) are dropped — that data model is not in the converged vault-centric tree.
import type { Database } from "../../db/types";
import type { Job, JobContext, JobResult } from "../plane";

export interface AuditReport {
  vault_null_embeddings: number;
  duplicate_chunk_positions: number;
  details: Record<string, unknown>;
}

interface CountRow {
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

  const report: AuditReport = {
    vault_null_embeddings: nullEmb.c,
    duplicate_chunk_positions: dupePositions.c,
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
