// THE-465 "projection" stage: final Candidate -> GraphSearchResult mapping, the optional
// bubble-safe activation composition (THE-233/THE-447), and the optional ColBERT late-interaction
// rerank (THE-388) that wraps the whole pipeline. Moved verbatim out of graph_search.ts's tail.
import type { Database } from "../../db/types";
import { bubbleSafeRerank } from "../bubble_safe_rerank";
import { loadChunkColbert } from "../chunk_colbert";
import { colbertRerank } from "../colbert";
import type { Candidate, GraphSearchOptions, GraphSearchResult } from "./types";

export function toResult(c: Candidate, score: number): GraphSearchResult {
  return {
    chunk_id: c.chunk_id,
    path: c.path,
    ...(c.content ? { content: c.content } : {}),
    source: c.source,
    hop: c.hop,
    via_edge: c.via_edge,
    root_seed: c.root_seed,
    rerank_score: score,
  };
}

// Apply the optional bubble-safe activation composition (THE-233), then project. Strictly
// off by default: without opts.bubbleSafe.enabled (or without activationFor) the fused order is
// returned untouched — the composition is an opt-in safety primitive. When enabled AND activation
// is available, the activation signal folds in as a bounded multiplier and a single bubble pass
// reorders the fused list so every item shifts by at most one position.
export function finalize(
  ranked: Array<{ item: Candidate; score: number }>,
  opts: GraphSearchOptions,
): GraphSearchResult[] {
  const activationFor = opts.activationFor;
  if (!opts.bubbleSafe?.enabled || !activationFor) {
    return ranked.map(({ item, score }) => toResult(item, score));
  }
  const withActivation = ranked.map(({ item, score }) => ({
    item,
    score,
    rerankScore: score,
    activationScore: activationFor(item.chunk_id) ?? null,
  }));
  return bubbleSafeRerank(withActivation, { k: opts.bubbleSafe.k }).map((r) =>
    toResult(r.item, r.score),
  );
}

// THE-447: the default graph_rrf/convex path projects directly (it does NOT route through
// finalize), so the bubble-safe composition is pre-plumbed here too — strictly off by default.
// Without opts.bubbleSafe.enabled (or without activationFor) this is BYTE-IDENTICAL to the prior
// `capped.map((c) => toResult(c, scoreOf(c)))` projection, so the default path is unchanged until a
// live signal (e.g. activation once THE-228 populates chunk_retrievals) turns it on and it is
// measured on the golden set.
export function projectWithBubbleSafe(
  items: Candidate[],
  scoreOf: (c: Candidate) => number,
  opts: GraphSearchOptions,
): GraphSearchResult[] {
  const activationFor = opts.activationFor;
  if (!opts.bubbleSafe?.enabled || !activationFor) {
    return items.map((c) => toResult(c, scoreOf(c)));
  }
  const withActivation = items.map((c) => ({
    item: c,
    score: scoreOf(c),
    rerankScore: scoreOf(c),
    activationScore: activationFor(c.chunk_id) ?? null,
  }));
  return bubbleSafeRerank(withActivation, { k: opts.bubbleSafe.k }).map((r) =>
    toResult(r.item, r.score),
  );
}

// THE-388: optional ColBERT late-interaction rerank of the fused top-K. Runs only when the query's
// ColBERT matrix is supplied AND chunk_colbert holds data; a no-op otherwise. Reranks the top
// colbertPool results by maxSim (bounded compute), leaving the tail order intact.
export function colbertRerankResults(
  db: Database,
  results: GraphSearchResult[],
  opts: GraphSearchOptions,
): GraphSearchResult[] {
  const q = opts.queryColbert;
  if (!q || q.length === 0 || results.length === 0) return results;
  const poolN = Math.min(opts.colbertPool ?? 40, results.length);
  const pool = results.slice(0, poolN);
  const docById = loadChunkColbert(
    db,
    pool.map((r) => r.chunk_id),
  );
  if (docById.size === 0) return results;
  return [...colbertRerank(pool, q, docById), ...results.slice(poolN)];
}
