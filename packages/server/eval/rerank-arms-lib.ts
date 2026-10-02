// Pure helpers for the reranker-arms eval (rerank-arms.ts): candidate pools, the orderings a
// reranker's scores induce, and the paired summaries. No I/O, no provider code, so every
// ordering rule is unit-testable (test/eval-rerank-arms.test.ts) without a network or an index.
//
// A "pool" is the dense top-K chunk list for one query, in dense order. Every arm reranks the SAME
// pool, so an arm differs from the dense control only by the order it puts those K chunks in.
import type { GoldenQuery, RankedChunk } from "./metrics";
import {
  benjaminiHochberg,
  pairedNonInferiority,
  pairedPermutationTest,
  powerReport,
  sampleStdev,
} from "./stats";

export interface PoolCandidate {
  chunk_id: string;
  path: string;
  text: string;
}

export interface Pool {
  id: string;
  query_text: string;
  /** The router's class for this query (lexical | temporal | standard): the only class a serving
   *  system can observe at query time, so the only one a class-gated reranker may key on. */
  route_class: string;
  candidates: PoolCandidate[];
}

export interface ScoreHit {
  index: number;
  score: number;
}

/** The first `k` candidates of a pool, in dense order. */
export function truncatePool(pool: Pool, k: number): Pool {
  return { ...pool, candidates: pool.candidates.slice(0, k) };
}

const toRanked = (c: PoolCandidate): RankedChunk => ({ chunk_id: c.chunk_id, path: c.path });

/** The dense control: the pool exactly as retrieved. */
export function denseOrder(pool: Pool): RankedChunk[] {
  return pool.candidates.map(toRanked);
}

/** Pure rerank order: descending score. Ties keep dense order (stable), and a candidate the provider
 *  returned no score for is appended in dense order, never dropped, so a partial response cannot
 *  shrink the pool. Out-of-range or repeated indices are ignored. */
export function rerankOrder(pool: Pool, hits: ScoreHit[]): RankedChunk[] {
  const n = pool.candidates.length;
  const best = new Map<number, number>();
  for (const h of hits) {
    if (!Number.isInteger(h.index) || h.index < 0 || h.index >= n || !Number.isFinite(h.score))
      continue;
    if (!best.has(h.index)) best.set(h.index, h.score);
  }
  const scored = [...best.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i]) => i);
  const rest = pool.candidates.map((_, i) => i).filter((i) => !best.has(i));
  return [...scored, ...rest].map((i) => toRanked(pool.candidates[i] as PoolCandidate));
}

/** Reciprocal-rank fusion of the dense order and the rerank order over the same chunks (the repo's
 *  fusion constant is 10, DEFAULT_RRF_K). The `rrf_rerank` fusion mode in the product's own terms. */
export function rrfFuseOrder(pool: Pool, hits: ScoreHit[], k = 10): RankedChunk[] {
  const rr = rerankOrder(pool, hits);
  const rrRank = new Map(rr.map((c, i) => [c.chunk_id, i]));
  return pool.candidates
    .map((c, i) => ({
      c,
      i,
      s: 1 / (k + i + 1) + 1 / (k + (rrRank.get(c.chunk_id) ?? pool.candidates.length) + 1),
    }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => toRanked(x.c));
}

/** Multi-hop = the query declares bridge notes (the label that makes a query multi-hop in this
 *  harness); everything else is single-hop. A bridge label is NOT observable at query time. */
export function hopClass(q: GoldenQuery): "multi-hop" | "single-hop" {
  return q.bridge_paths.length > 0 ? "multi-hop" : "single-hop";
}

/** Class-gated order: rerank only when the query's (serving-time) class is in `rerankClasses`,
 *  otherwise keep dense. */
export function gatedOrder(
  pool: Pool,
  hits: ScoreHit[] | undefined,
  rerankClasses: ReadonlySet<string>,
): RankedChunk[] {
  return hits && rerankClasses.has(pool.route_class) ? rerankOrder(pool, hits) : denseOrder(pool);
}

export interface PairedSummary {
  n: number;
  meanBase: number;
  meanArm: number;
  delta: number;
  p: number;
  /** One-sided 95% lower bound on the delta, and whether it clears the non-inferiority floor. */
  lower: number;
  nonInferior: boolean;
  sigmaD: number;
  /** Minimum detectable effect at this n (alpha .05 two-sided, power .8) from THIS sample's sigma_d. */
  mde: number;
  wins: number;
  losses: number;
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Paired comparison of one metric, arm minus control, over the same queries. */
export function summarizePaired(base: number[], arm: number[], margin = -0.015): PairedSummary {
  const d = arm.map((v, i) => v - (base[i] ?? 0));
  const ni = pairedNonInferiority(d, { margin });
  const pw = powerReport(d);
  return {
    n: d.length,
    meanBase: mean(base),
    meanArm: mean(arm),
    delta: mean(d),
    p: pairedPermutationTest(d),
    lower: ni.lowerBound,
    nonInferior: ni.nonInferior,
    sigmaD: sampleStdev(d),
    mde: pw.mde,
    wins: d.filter((x) => x > 1e-12).length,
    losses: d.filter((x) => x < -1e-12).length,
  };
}

export type CorpusVerdict = "WIN" | "TIE" | "LOSS" | "CATASTROPHIC" | "UNDERPOWERED";

/** The pre-registered per-corpus verdict on nDCG@10 (see PREREGISTRATION.md). `bhRejected` is the
 *  Benjamini-Hochberg decision across the family of primary comparisons on that corpus. */
export function corpusVerdict(s: PairedSummary, bhRejected: boolean): CorpusVerdict {
  if (bhRejected && s.delta > 0) return "WIN";
  if (bhRejected && s.delta < 0) return s.delta <= -0.05 ? "CATASTROPHIC" : "LOSS";
  return s.nonInferior ? "TIE" : "UNDERPOWERED";
}

/** BH-FDR (q=0.1) over the permutation p-values of a family of summaries. */
export function bhDecisions(ps: number[], q = 0.1): boolean[] {
  return benjaminiHochberg(ps, q).map((r) => r.rejected);
}

/** Cloudflare Workers AI bills bge-reranker-base per input token: 283 neurons per million tokens
 *  (the account's published rate). Text-length proxy: 4 characters per token. */
export const CF_NEURONS_PER_M_TOKENS = 283;
export function estimateNeurons(chars: number): number {
  return ((chars / 4) * CF_NEURONS_PER_M_TOKENS) / 1_000_000;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
}
