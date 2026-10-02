// Read-side of the wiki judge's cache.db tables (wiki_judge_usage, wiki_judge_verdicts), shared by the
// judge engine and `doctor` so neither imports the other's layer.
import type { Database } from "./types";

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function readJudgeUsage(
  db: Database,
  now: number,
): { calls: number; failures: number; model: string | null; cached: number } {
  try {
    const u = db
      .prepare("SELECT calls, failures FROM wiki_judge_usage WHERE day = ?")
      .get(utcDay(now)) as { calls: number; failures: number } | undefined;
    const m = db
      .prepare("SELECT model FROM wiki_judge_verdicts ORDER BY judged_at DESC LIMIT 1")
      .get() as { model: string } | undefined;
    const n = db.prepare("SELECT count(*) AS n FROM wiki_judge_verdicts").get() as { n: number };
    return {
      calls: u?.calls ?? 0,
      failures: u?.failures ?? 0,
      model: m?.model ?? null,
      cached: n.n,
    };
  } catch {
    // An un-migrated cache.db has neither table: no judge has ever run against it.
    return { calls: 0, failures: 0, model: null, cached: 0 };
  }
}
