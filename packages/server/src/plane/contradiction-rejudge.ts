// Re-judge the open contradiction flags with the CURRENT judge — the one-time data fix behind
// `obsidian-tc contradiction-rejudge`. A 100-pair audit of stored rows found the original judge
// (gpt-4.1) flagged conflicts that two frontier labelers called no_conflict on 81/86 pairs, and the
// stored verdict matched the labelers on 3/86. The owner chose RE-JUDGE over purge: a purge would
// silently drop the real flags until each chunk happens to be re-indexed (the detector only judges
// a chunk when it is freshly indexed), whereas a re-judge keeps what the better judge confirms.
//
// What this shares with the detector rather than re-implements (plane/jobs/contradiction.ts):
// `buildJudgeRequest` (byte-identical request shape), `parseVerdict`, `mapLimit`, and the same
// egress filtering. What it deliberately does NOT share: the detector's insert path — this only
// ever updates existing rows, so it can never create a flag.
//
// Resume-safe and idempotent per row: a row is eligible iff `status = 'open' AND rejudged_at IS
// NULL`, and the UPDATE that records a ruling carries the same predicate. Each row is written the
// moment its judge call returns, so an interrupted run loses at most the in-flight calls and the
// next run picks up exactly the rows with no ruling. A row the judge could not rule on (call threw,
// reply unparseable) is left untouched and is retried next run — a failure is never recorded as a
// verdict (THE-613).
import type { Database } from "../db/types";
import { contentHash } from "../vault/paths";
import { type EgressFilter, EgressViolationError, isExcludedPath } from "./egress-filter";
import type { GatewayRoles } from "./gateway";
import { buildJudgeRequest, mapLimit, parseVerdict } from "./jobs/contradiction";

export interface RejudgeOptions {
  /** Restrict to one vault. Absent = every vault in the table. */
  vaultId?: string;
  /** Only rows whose stored `judge_model` equals this — e.g. `judge`, the alias every pre-provenance
   *  row carries — so rows the detector already wrote with a resolved model are left alone. */
  judgeModel?: string;
  /** Cap on gateway calls this run (oldest rows first). */
  limit?: number;
  /** Judge calls in flight at once. Default 2. */
  concurrency?: number;
  /** Pause after each call, per worker, in ms — the rate limit. Default 250. */
  delayMs?: number;
}

export interface RejudgeCounts {
  /** Open rows by stored verdict BEFORE this run's changes (the "before" half of a report). */
  openByVerdict: Record<string, number>;
  open: number;
  /** Open rows that already carry a ruling (`rejudged_at` set) — skipped. */
  alreadyRejudged: number;
  /** Open, unruled rows excluded by `--judge-model`. */
  otherModel: number;
  /** A chunk is gone or its content changed since detection: the stored pair no longer describes
   *  what is in the vault, so there is nothing faithful to re-judge. Left open, untouched. */
  stale: number;
  /** A side is under `egress.excludePaths`: never sent to the judge. Left open, untouched. */
  excluded: number;
  /** Rows that would be (or were attempted to be) judged this run, after `limit`. */
  eligible: number;
}

export interface RejudgeStats extends RejudgeCounts {
  /** Gateway calls that returned a parseable verdict. */
  judged: number;
  /** Re-judged and still flagged (verdict possibly changed contradiction <-> tension). */
  confirmed: number;
  /** Re-judged no_conflict -> status 'dismissed'. */
  dismissed: number;
  /** Could not rule (call threw / unparseable): row untouched, retried next run. */
  unjudged: number;
  judgeErrors: number;
  /** Resolved model(s) the verdicts were recorded under, with row counts. */
  models: Record<string, number>;
  /** Open rows by verdict AFTER this run. */
  openByVerdictAfter: Record<string, number>;
}

interface PendingRow {
  id: string;
  source_chunk_id: string;
  source_path: string;
  conflict_chunk_id: string;
  conflict_path: string;
  source_content_sha: string;
  conflict_content_sha: string;
  judge_model: string | null;
  rejudged_at: number | null;
}

interface RejudgeTask {
  id: string;
  source: { path: string; content: string };
  conflict: { path: string; content: string };
}

function openByVerdict(db: Database, vaultId: string | undefined): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT judge_verdict AS verdict, COUNT(*) AS n FROM contradictions
       WHERE status = 'open' ${vaultId !== undefined ? "AND vault_id = ?" : ""} GROUP BY judge_verdict`,
    )
    .all(...(vaultId !== undefined ? [vaultId] : [])) as Array<{ verdict: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.verdict, r.n]));
}

/** Read-only: classify every open row and build the judge tasks. The dry run is exactly this. */
export function planRejudge(
  db: Database,
  opts: RejudgeOptions,
  excludeFilter?: EgressFilter,
): { counts: RejudgeCounts; tasks: RejudgeTask[] } {
  const rows = db
    .prepare(
      `SELECT id, source_chunk_id, source_path, conflict_chunk_id, conflict_path,
              source_content_sha, conflict_content_sha, judge_model, rejudged_at, vault_id
       FROM contradictions WHERE status = 'open' ${opts.vaultId !== undefined ? "AND vault_id = ?" : ""}
       ORDER BY detected_at ASC, id ASC`,
    )
    .all(...(opts.vaultId !== undefined ? [opts.vaultId] : [])) as Array<
    PendingRow & { vault_id: string }
  >;
  const chunkContent = db.prepare("SELECT content FROM chunks WHERE id = ? AND vault_id = ?");
  const counts: RejudgeCounts = {
    openByVerdict: openByVerdict(db, opts.vaultId),
    open: rows.length,
    alreadyRejudged: 0,
    otherModel: 0,
    stale: 0,
    excluded: 0,
    eligible: 0,
  };
  const tasks: RejudgeTask[] = [];
  for (const r of rows) {
    if (r.rejudged_at !== null) {
      counts.alreadyRejudged += 1;
      continue;
    }
    if (opts.judgeModel !== undefined && r.judge_model !== opts.judgeModel) {
      counts.otherModel += 1;
      continue;
    }
    if (
      excludeFilter !== undefined &&
      (isExcludedPath(excludeFilter, r.source_path) ||
        isExcludedPath(excludeFilter, r.conflict_path))
    ) {
      counts.excluded += 1;
      continue;
    }
    const src = chunkContent.get(r.source_chunk_id, r.vault_id) as { content: string } | undefined;
    const con = chunkContent.get(r.conflict_chunk_id, r.vault_id) as
      | { content: string }
      | undefined;
    if (
      !src ||
      !con ||
      contentHash(src.content) !== r.source_content_sha ||
      contentHash(con.content) !== r.conflict_content_sha
    ) {
      counts.stale += 1;
      continue;
    }
    tasks.push({
      id: r.id,
      source: { path: r.source_path, content: src.content },
      conflict: { path: r.conflict_path, content: con.content },
    });
  }
  const capped = opts.limit !== undefined ? tasks.slice(0, Math.max(0, opts.limit)) : tasks;
  counts.eligible = capped.length;
  return { counts, tasks: capped };
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function rejudgeContradictions(
  ctx: {
    db: Database;
    judge: GatewayRoles["judge"];
    now: () => number;
    excludeFilter?: EgressFilter;
    /** Delay seam for tests. */
    sleepFn?: (ms: number) => Promise<void>;
  },
  opts: RejudgeOptions,
): Promise<RejudgeStats> {
  const { db } = ctx;
  const { counts, tasks } = planRejudge(db, opts, ctx.excludeFilter);
  const stats: RejudgeStats = {
    ...counts,
    judged: 0,
    confirmed: 0,
    dismissed: 0,
    unjudged: 0,
    judgeErrors: 0,
    models: {},
    openByVerdictAfter: {},
  };
  // The predicate repeats the eligibility one so a concurrent run (or a row that changed under us)
  // can never be ruled on twice.
  const confirm = db.prepare(
    `UPDATE contradictions SET judge_verdict = ?, judge_rationale = ?, judge_model = ?, rejudged_at = ?
     WHERE id = ? AND status = 'open' AND rejudged_at IS NULL`,
  );
  // A dismissed row keeps its ORIGINAL judge_verdict / judge_rationale / judge_model — the flag as
  // it was made — and the new judge's ruling lives in resolution_reason.
  const dismiss = db.prepare(
    `UPDATE contradictions SET status = 'dismissed', resolved_at = ?, rejudged_at = ?, resolution_reason = ?
     WHERE id = ? AND status = 'open' AND rejudged_at IS NULL`,
  );
  const delayMs = opts.delayMs ?? 250;
  const sleep = ctx.sleepFn ?? realSleep;
  await mapLimit(tasks, Math.max(1, opts.concurrency ?? 2), async (t) => {
    let verdict: ReturnType<typeof parseVerdict> = null;
    let model = "";
    let threw = false;
    try {
      const res = await ctx.judge(buildJudgeRequest(t.source, t.conflict));
      verdict = parseVerdict(res.text);
      model = res.model;
    } catch (e) {
      // A guard firing means the filtering in planRejudge is broken — a security defect, not an
      // ordinary judge failure (same rule as the detector).
      if (e instanceof EgressViolationError) throw e;
      threw = true;
    }
    if (verdict === null) {
      stats.unjudged += 1;
      if (threw) stats.judgeErrors += 1;
    } else {
      const at = ctx.now();
      stats.judged += 1;
      stats.models[model] = (stats.models[model] ?? 0) + 1;
      if (verdict.kind === "no_conflict") {
        const info = dismiss.run(
          at,
          at,
          `rejudge: no_conflict (${model}) — ${verdict.rationale}`,
          t.id,
        );
        if (info.changes > 0) stats.dismissed += 1;
      } else {
        const info = confirm.run(verdict.kind, verdict.rationale, model, at, t.id);
        if (info.changes > 0) stats.confirmed += 1;
      }
    }
    if (delayMs > 0) await sleep(delayMs);
  });
  stats.openByVerdictAfter = openByVerdict(db, opts.vaultId);
  return stats;
}
