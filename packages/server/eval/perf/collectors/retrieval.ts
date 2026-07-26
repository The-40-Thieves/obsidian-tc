import { performance } from "node:perf_hooks";
import { deterministicVector } from "../../../src/embeddings/fake";
import { ensureChunkColbert, upsertChunkColbert } from "../../../src/search/chunk_colbert";
import type { ColbertMatrix } from "../../../src/search/colbert";
import { graphSearch } from "../../../src/search/graph_search";
import { jsTokenize } from "../../../src/search/native";
import type { VaultCtx } from "../harness";
import { LABELLED } from "../labelled";
import type { MetricSample } from "../report";

function dcg(hits: boolean[]): number {
  return hits.reduce((acc, hit, i) => acc + (hit ? 1 / Math.log2(i + 2) : 0), 0);
}

// THE-418: the ColBERT late-interaction stage (colbertRerankResults / maxSim, projection.ts) had
// no perf coverage at all — every scenario called graphSearch with queryVec only, so
// opts.queryColbert was always undefined and the stage hit its early return every time. Dim 32
// matches this collector's existing queryVec dim (deterministicVector(q.query, 32) below).
//
// This is gated to the dedicated `colbert` scenario (scenarios.ts) rather than running on every
// scenario: seeding chunk_colbert is a real, permanent write against the vault's db, and `small` /
// `densify` are CI-gated on storage.bytes (collectors/storage.ts, PRAGMA page_count * page_size on
// this SAME db). Seeding there inflated storage.bytes ~39% and failed the perf gate — the
// measurement instrument mutating the thing another collector measures. Isolating it to its own
// scenario is what the fix below buys: `small`/`densify` are byte-for-byte unaffected (no
// chunk_colbert table, no extra rows), and the ColBERT stage still gets a real, non-zero, timed
// measurement on `colbert` — closer to what THE-418 wants anyway (a dedicated scenario, not a
// side effect bolted onto an unrelated one).
const COLBERT_DIM = 32;
// Bounds the per-chunk token matrix so seeding cost stays proportional to a chunk, not a whole
// document: real bge-m3 output is one row per input token, and this corpus's chunks are ~1-2
// paragraphs of harness.ts's paragraph() (24 words each) — 32 covers a chunk without inventing a
// pathologically long one.
const COLBERT_DOC_TOKENS = 32;
const COLBERT_QUERY_TOKENS = 8;

/** Deterministic ColBERT-shaped matrix: one row per token (capped), each row a deterministic unit
 *  vector keyed on that token — same generator family as deterministicVector, just one draw per
 *  token instead of one draw for the whole text. Empty text -> empty matrix (no tokens -> no-op,
 *  matching maxSim's `query.length === 0` contract). */
function colbertMatrixFor(text: string, maxTokens: number): ColbertMatrix {
  return jsTokenize(text)
    .slice(0, maxTokens)
    .map((tok) => deterministicVector(tok, COLBERT_DIM));
}

/** Seed every chunk in the vault with a deterministic ColBERT matrix. The perf harness's
 *  fakeEmbeddingProvider has no embedFull() (dense-only), so indexVault never provisions
 *  chunk_colbert on its own (indexer.ts gates ensureChunkColbert behind `hasEmbedFull`) — without
 *  this, passing queryColbert below would still hit colbertRerankResults's
 *  `docById.size === 0 -> return results` no-op, and the maxSim inner loop this ticket exists to
 *  measure would never run. */
function seedColbert(vault: VaultCtx): void {
  if (!ensureChunkColbert(vault.db)) return;
  const rows = vault.db
    .prepare("SELECT id, content FROM chunks WHERE vault_id = ?")
    .all(vault.vaultId) as Array<{ id: string; content: string }>;
  for (const row of rows) {
    const matrix = colbertMatrixFor(row.content, COLBERT_DOC_TOKENS);
    if (matrix.length > 0) upsertChunkColbert(vault.db, row.id, vault.vaultId, matrix);
  }
}

/** Families 8 (graph candidate counts per stage) + 9 (recall/nDCG per ms) + THE-418's ColBERT
 *  coverage (the "projection" stage duration, which wraps colbertRerankResults — see
 *  graph_search.ts) on the dedicated `colbert` scenario only. Deterministic vault -> deterministic
 *  counts + relevance; per-ms and colbert_ms are the warn-only latency figures. */
export async function collectRetrieval(vault: VaultCtx): Promise<MetricSample[]> {
  const withColbert = vault.scenario.name === "colbert";
  if (withColbert) seedColbert(vault);
  const stageCounts: Record<string, number> = { seed: 0, expand: 0, fused: 0 };
  let recallSum = 0;
  let ndcgSum = 0;
  let totalMs = 0;
  let colbertMs = 0;

  for (const q of LABELLED) {
    const t0 = performance.now();
    const results = (await graphSearch(vault.db, {
      query: q.query,
      queryVec: deterministicVector(q.query, 32),
      // THE-418: exercises colbertRerankResults's maxSim pool (bounded to
      // min(colbertPool ?? 40, results.length) in projection.ts — realistic given finalTopK below,
      // not a pathologically inflated pool) instead of leaving it permanently a no-op. Only on the
      // `colbert` scenario (see seedColbert's caller above) -- everywhere else this stays
      // `undefined`, exactly the pre-THE-418 shape, so `small`/`densify` are unaffected.
      ...(withColbert ? { queryColbert: colbertMatrixFor(q.query, COLBERT_QUERY_TOKENS) } : {}),
      vaultId: vault.vaultId,
      finalTopK: 10,
      onStage: (stage, count) => {
        if (stage in stageCounts)
          stageCounts[stage] = Math.max(stageCounts[stage] as number, count);
      },
      onStageMetric: (m) => {
        if (m.stage === "projection") colbertMs += m.durationMs;
      },
    })) as Array<{ path: string }>;
    totalMs += performance.now() - t0;

    const top = results.slice(0, 10).map((r) => q.relevantPaths.includes(r.path));
    const found = top.filter(Boolean).length;
    recallSum += q.relevantPaths.length > 0 ? found / q.relevantPaths.length : 0;
    const ideal = dcg(new Array(Math.min(10, q.relevantPaths.length)).fill(true));
    ndcgSum += ideal > 0 ? dcg(top) / ideal : 0;
  }

  const n = LABELLED.length;
  const recall = recallSum / n;
  const ndcg = ndcgSum / n;
  const perMs = totalMs > 0 ? ndcg / (totalMs / n) : 0;
  const colbertMsAvg = colbertMs / n;

  return [
    {
      key: "graph.candidates_seed",
      value: stageCounts.seed as number,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "graph.candidates_expand",
      value: stageCounts.expand as number,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "graph.candidates_fused",
      value: stageCounts.fused as number,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "retrieval.recall_at10",
      value: recall,
      unit: "ratio",
      class: "hard",
      direction: "lower-worse",
    },
    {
      key: "retrieval.ndcg_at10",
      value: ndcg,
      unit: "ratio",
      class: "hard",
      direction: "lower-worse",
    },
    {
      key: "retrieval.ndcg_per_ms",
      value: perMs,
      unit: "ratio",
      class: "warn",
      direction: "lower-worse",
    },
    // THE-418: mean "projection" stage duration (colbertRerankResults's maxSim pool, bounded to
    // colbertPool ?? 40 results) across the labelled queries, `colbert` scenario only. Emitted only
    // when actually measured, not as a phantom zero for every other scenario — same convention as
    // collectDensification (a zero that always matches a zero baseline is a gate on nothing).
    // Unbaselined deliberately — Cave's dev-host calibration CV (perf-baseline.yml) fails its own
    // 0.2 threshold, so no trustworthy number can be recorded here; gate.ts walks the baseline, not
    // the report, so an unbaselined key is reported but never gated. warn-class latency, like
    // ndcg_per_ms above.
    ...(withColbert
      ? [
          {
            key: "retrieval.colbert_ms",
            value: colbertMsAvg,
            unit: "ms" as const,
            class: "warn" as const,
            direction: "higher-worse" as const,
          },
        ]
      : []),
  ];
}
