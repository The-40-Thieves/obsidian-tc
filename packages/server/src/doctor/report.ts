// THE-521 — running checks into a report, and rendering text FROM the report.
//
// JSON-primary is the load-bearing decision (Flutter's cautionary tale): runDoctor returns the
// structured report, renderText consumes it. Text can therefore never state a fact the JSON omits.
import type { Check, CheckStatus, DoctorCheck, DoctorContext, DoctorReport } from "./types";

const SCHEMA_VERSION = 1;

// fail dominates warning dominates ok — the aggregate is the worst individual status.
const RANK: Record<CheckStatus, number> = { ok: 0, warning: 1, fail: 2 };

function worst(a: CheckStatus, b: CheckStatus): CheckStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Run every check, timing each and isolating failures: a check that throws becomes a fail result
 * whose issue is the error message, so one broken probe can never take down the run. Returns the
 * versioned envelope with checks keyed by their dotted id.
 */
export async function runDoctor(checks: Check[], ctx: DoctorContext): Promise<DoctorReport> {
  const now = ctx.now ?? (() => new Date().toISOString());
  const monotonic = ctx.monotonic ?? (() => performance.now());

  const out: Record<string, DoctorCheck> = {};
  let overall: CheckStatus = "ok";

  for (const check of checks) {
    const start = monotonic();
    let result: DoctorCheck;
    try {
      const r = await check.run(ctx);
      result = { ...r, id: check.id, category: check.category, durationMs: monotonic() - start };
    } catch (e) {
      result = {
        id: check.id,
        category: check.category,
        status: "fail",
        summary: `${check.id} threw while probing`,
        issues: [(e as Error).message],
        durationMs: monotonic() - start,
      };
    }
    out[check.id] = result;
    overall = worst(overall, result.status);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now(),
    overallStatus: overall,
    serverVersion: ctx.serverVersion,
    checks: out,
  };
}

const GLYPH: Record<CheckStatus, string> = { ok: "✓", warning: "!", fail: "✗" };

/** Render human-readable text from a report. Consumes only the report, never re-probes. */
export function renderText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`obsidian-tc doctor — ${report.serverVersion} (${report.generatedAt})`);
  lines.push(`overall: ${report.overallStatus.toUpperCase()}`);
  lines.push("");

  // Stable, id-sorted order so the text output is diffable between runs.
  for (const id of Object.keys(report.checks).sort()) {
    const c = report.checks[id];
    if (!c) continue;
    lines.push(`${GLYPH[c.status]} ${c.id} [${c.category}] — ${c.summary}`);
    for (const [k, v] of Object.entries(c.details ?? {})) {
      lines.push(`    ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
    for (const issue of c.issues ?? []) lines.push(`    ! ${issue}`);
    for (const note of c.notes ?? []) lines.push(`    · ${note}`);
    if (c.remediation) lines.push(`    → ${c.remediation}`);
  }
  return lines.join("\n");
}
