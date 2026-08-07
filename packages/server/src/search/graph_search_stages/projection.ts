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
  // THE-424 Part A wired this to the serve path: the M7 options builder
  // (tools/m7/knowledge/retrieval-runtime.ts) now sets bubbleSafe alongside activationFor, both
  // gated on config.experiential.activationRerank. THE-535 previously recorded this branch as
  // unreachable outside eval/run.ts and the tests; that is no longer true, and the damping
  // argument the wiring owed lives at the call site.
  // Still strictly off by DEFAULT — activationRerank ships false, so the guard below remains the
  // production path until an operator opts in.
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
// finalize), so the bubble-safe composition is wired here too — strictly off by default.
// Without opts.bubbleSafe.enabled (or without activationFor) this is BYTE-IDENTICAL to the prior
// `capped.map((c) => toResult(c, scoreOf(c)))` projection, so the DEFAULT config is unchanged: what
// THE-424 Part A added is an operator's ability to turn it on, not a change to what ships. The
// measurement that decides whether the default should move is Part B — see the note on `finalize`
// above.
export function projectWithBubbleSafe(
  items: Candidate[],
  scoreOf: (c: Candidate) => number,
  opts: GraphSearchOptions,
): GraphSearchResult[] {
  const activationFor = opts.activationFor;
  // This is the gate the DEFAULT serve path (fusionMode graph_rrf/convex — what every M7 tool call
  // site uses) actually hits, so it is the one THE-424 Part A had to reach. Same story as
  // `finalize` above: the options builder sets bubbleSafe and activationFor together under
  // config.experiential.activationRerank, and the bubble pass below is now reachable in production
  // when an operator turns that flag on. It stays inert on the default config, which ships false.
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
