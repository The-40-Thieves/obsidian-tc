// THE-719 — the scheduled coverage-gap sweep.
//
// `detectGaps` had exactly one caller: the offline `obsidian-tc gaps` CLI. So `gap_reports` held 0
// rows on a deployment that had been running for weeks, and the THE-611 read tool it was built for
// had nothing to read. Correct code, complete tests, a working read surface, and no scheduled
// caller — the same shape as THE-698's evaluator and THE-717's citation pass. This module is the
// caller.
//
// TWO THINGS THIS FILE EXISTS TO GET RIGHT:
//
//   1. The search closure is shared with the CLI rather than copied. Two copies of "embed the batch,
//      then graphSearch each query" would drift, and the drift would be silent in the direction that
//      matters — a sweep scoring queries differently from the calibration run that set the threshold
//      produces gap counts that cannot be compared to anything.
//   2. A SCHEDULED pass has no --queries file, so the query source is a real design choice rather
//      than a parameter. It draws the most recent DISTINCT logged queries: what was actually asked
//      is the only query set that makes an unattended "where is the vault thin?" question
//      meaningful. A fixed golden set would measure the golden set forever.
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import { detectGaps, type GapBatchSearchFn, persistGapReport } from "../experiential/gaps";
import type { Scheduler } from "../scheduler/scheduler";
import { graphSearch } from "../search/graph_search";
import { stderrOnError } from "../util/errors";

/**
 * The batch-shaped search seam `detectGaps` takes, built once and shared by the CLI and the sweep.
 *
 * THE-616 shape, preserved exactly: ONE `provider.embed(queries[])` for the whole batch, then
 * graphSearch one query at a time in a plain sequential loop — never `Promise.all`. Only the embed
 * call batches, so this adds no concurrency pressure on the gateway.
 */
export function makeGapBatchSearch(deps: {
  cacheDb: Database;
  provider: EmbeddingProvider;
  vaultId: string;
  rrfK?: number | undefined;
}): GapBatchSearchFn {
  return async (queries) => {
    if (queries.length === 0) return [];
    const vecs = await deps.provider.embed(queries, { input: "query" });
    const out: Array<Array<{ path: string; score: number }>> = [];
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i] as string;
      const results = await graphSearch(deps.cacheDb, {
        query,
        queryVec: vecs[i] ?? [],
        vaultId: deps.vaultId,
        model: deps.provider.id, // THE-530: constrain seeds to the active model
        finalTopK: 10,
        ...(deps.rrfK !== undefined ? { rrfK: deps.rrfK } : {}),
        reranker: null,
      });
      out.push(results.map((r) => ({ path: r.path, score: r.rerank_score })));
    }
    return out;
  };
}

/**
 * The most recent DISTINCT logged queries, newest first.
 *
 * GROUP BY rather than SELECT DISTINCT: with DISTINCT, SQLite cannot order by a column that is not
 * in the select list, and ordering by `MAX(retrieved_at)` is what makes "recent" mean recent rather
 * than "whatever order the b-tree yields".
 */
export function recentQueries(edb: Database, limit: number): string[] {
  const rows = edb
    .prepare(
      `SELECT query_text, MAX(retrieved_at) AS t FROM chunk_retrievals
       WHERE query_text IS NOT NULL AND query_text <> ''
       GROUP BY query_text ORDER BY t DESC LIMIT ?`,
    )
    .all(limit) as Array<{ query_text: string }>;
  return rows.map((r) => r.query_text);
}

export interface GapSweepDeps {
  cacheDb: Database;
  experientialDb: Database;
  provider: EmbeddingProvider;
  vaultIds: string[];
  intervalMs: number;
  maxQueries: number;
  rrfK?: number | undefined;
  /** Injected for tests; production passes nothing and gets Date.now. */
  now?: () => number;
}

/**
 * Register the sweep. The caller decides whether to call this at all — it is gated on
 * `experiential.gapSweep.enabled`, which defaults FALSE, because each swept query costs an
 * embedding call plus a search and no deployment should pay that without asking.
 *
 * ADVISORY ONLY, and this must survive any future change: the sweep persists an observation and
 * stops. Nothing here emits a config delta. A system that tuned its own retrieval config from its
 * own gap measurements has no independent signal to check itself against, and this repo's two
 * pre-registered sweeps (THE-532 null, THE-448 −0.047 nDCG@10) both showed plausible tuning
 * frequently makes things worse.
 */
export function registerGapSweep(scheduler: Scheduler, deps: GapSweepDeps): void {
  const now = deps.now ?? Date.now;
  scheduler.register({
    name: "gap-sweep",
    intervalMs: deps.intervalMs,
    run: async () => {
      for (const vaultId of deps.vaultIds) {
        const queries = recentQueries(deps.experientialDb, deps.maxQueries);
        // Nothing logged yet is not a failure and must not write an empty report: a gap_reports row
        // claiming 0/0 would read downstream exactly like a sweep that found no gaps.
        if (queries.length === 0) continue;
        const search = makeGapBatchSearch({
          cacheDb: deps.cacheDb,
          provider: deps.provider,
          vaultId,
          ...(deps.rrfK !== undefined ? { rrfK: deps.rrfK } : {}),
        });
        const report = await detectGaps(
          queries.map((q, i) => ({ id: `recent-${i}`, query: q })),
          search,
          {},
        );
        persistGapReport(deps.experientialDb, report, { vaultId, computedAt: now() });
      }
    },
    onError: stderrOnError("gap-sweep"),
  });
}
