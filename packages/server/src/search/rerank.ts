/**
 * Rerank seam — THE-233 W-RETRIEVAL (D1). The model call routes through the self-hosted
 * gateway's Cohere-compatible /rerank passthrough (rerank-v3.5 quality, no provider SDK in
 * the tree). The W-GATEWAY-CLIENT lives on its own branch, so the reranker is *injected*
 * here; at integration, adapt the gateway client:
 *
 *   const reranker: Reranker = (q, docs, topN) =>
 *     gatewayClient.rerank({ query: q, documents: docs, topN }).then((r) => r.results);
 *
 * The default is the graceful no-op fallback (KMS reranker.ts behavior): on a missing
 * reranker or any error, retrieval degrades to the pre-rerank order with synthetic
 * descending scores, never throwing.
 *
 * that fallback is deliberately silent about WHY it fired — "not configured",
 * "policy skipped it", "it timed out", "it returned garbage", and "it genuinely produced
 * this order" were all indistinguishable from the caller's side. `RerankOutcome` +
 * `onOutcome` close that gap additively: the return shape and the fallback SCORES are
 * unchanged for every existing caller, this only adds a best-effort side-channel report.
 */
import {
  assertSourcePathsAllowed,
  type EgressFilter,
  isExcludedPath,
} from "../plane/egress-filter";

export interface RerankHit {
  index: number;
  relevanceScore: number;
}

/** Scores documents against a query, returning hits by descending relevance. `sourcePaths`
 *  (THE-934) is parallel to `documents`. Fix round 2 (N3): every `Reranker` VALUE a consumer can
 *  obtain is wrapped by `guardReranker` before it is handed out (providers/registry.ts's
 *  `resolveReranker`, and runtime/tool-wiring.ts's `wireGatewaySeams` for the no-declared-block
 *  default) — a hosted reranker is a content-bearing egress leg exactly like
 *  extract/synthesize/judge, and it is a THIRD port (neither `createGatewayClient` nor
 *  `createEmbeddingProvider` construct one), so it needed its own guard rather than inheriting
 *  either factory's. `rerankWithScores` below is the ONE call site every guarded reranker is
 *  invoked from in production, and it has already dropped excluded-path docs before this is
 *  called — see its own doc comment; the guard is the backstop, not the primary filter. */
export type Reranker = (
  query: string,
  documents: string[],
  topN: number,
  sourcePaths: string[],
) => Promise<RerankHit[]>;

/**
 * THE-934 fix round 2 (N3): the reranker PORT guard. Wraps any `Reranker` VALUE — regardless of
 * which transport built it (gateway passthrough, model-tier, the generic cohere-compatible HTTP
 * adapter, the local package, or the profile-gated module hatch) — so every one of them refuses a
 * call whose `sourcePaths` is undeclared or names an excluded path, the same unconditional
 * declaration requirement `guardGatewayClient`/`withEgressGuard` apply to their own ports. `async`
 * deliberately (not a plain arrow returning `reranker(...)`) so a thrown guard check becomes a
 * rejected promise, never a synchronous throw at the call site — see embeddings/index.ts's
 * `withEgressGuard` for the bug this exact shape was written to avoid.
 */
export function guardReranker(reranker: Reranker, filter: EgressFilter): Reranker {
  return async (query, documents, topN, sourcePaths) => {
    assertSourcePathsAllowed(filter, "rerank", sourcePaths);
    return reranker(query, documents, topN, sourcePaths);
  };
}

export interface RankableDoc {
  content: string;
  /** THE-934 fix round 1 (I2): required so rerankWithScores can drop an excluded-path doc before
   *  it ever reaches a reranker implementation — a hosted reranker is a content-bearing egress
   *  leg exactly like extract/synthesize/judge. Every real candidate type in the retrieval
   *  pipeline already carries a path (a cluster_summary candidate's `path` is its cluster_key,
   *  never a real vault path, and so never matches an exclude glob — harmless). */
  path: string;
}

/** the reason `rerankWithScores` returned what it returned, reported through `onOutcome`
 *  (never inferable from the return value alone — every non-"executed" state produces the same
 *  shaped fallback output). `skipped_by_policy` is never emitted from inside this function — a
 *  caller that decides not to invoke the reranker at all (e.g. the gatedRerank hardness gate not
 *  firing) reports it directly; see graph_search_stages/rerank_stage.ts. */
export type RerankOutcome =
  | "not_configured" // reranker was null/undefined
  | "skipped_by_policy" // the caller chose not to invoke the reranker this call
  | "executed" // the reranker ran and returned at least one usable hit
  | "timed_out" // the reranker call exceeded timeoutMs
  | "malformed_response" // the reranker call returned but produced no usable hits
  | "provider_error" // the reranker call rejected for a reason other than a timeout
  | "fallback_used"; // fallback fired for a reason with no more specific outcome (empty input)

export type OnRerankOutcome = (outcome: RerankOutcome) => void;

/** Reranking is a bounded round-trip over an already-hydrated candidate set (unlike the embedding
 *  provider's batch calls), so a tighter budget than embeddings/http.ts's 30s would be defensible.
 *
 *  DELIBERATELY OPT-IN, NOT DEFAULTED. This module's job is to make an existing silent fallback
 *  observable; imposing a timeout that did not previously exist is a latency-vs-quality decision,
 *  and defaulting it here would mean a rerank that used to take 12s and SUCCEED now silently falls
 *  back — the exact failure this change exists to expose, introduced by the change itself.
 *
 *  `timeoutMs` is therefore undefined by default and no production call site passes one today. The
 *  mechanism and the "timed_out" outcome are in place so a follow-up can enable it with a measured
 *  value; until then reranking stays bounded only by the provider/gateway budget, as before. */
const DEFAULT_RERANK_TIMEOUT_MS: number | undefined = undefined;

class RerankTimeoutError extends Error {}

/** Races `promise` against a timer, per the hardware.ts/scheduler.ts Promise.race idiom. The timer
 *  is `unref`'d so it never keeps the process alive, and always cleared so the loser of the race
 *  cannot fire later. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RerankTimeoutError(`reranker exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort report, exported so rerank_stage.ts's "skipped_by_policy" call site shares the same
 *  guard: a throwing sink must never affect the ranking `rerankWithScores`/its caller returns, and
 *  must never mask whatever real error/result is already being handled around it. */
export function reportRerankOutcome(
  onOutcome: OnRerankOutcome | undefined,
  outcome: RerankOutcome,
): void {
  try {
    onOutcome?.(outcome);
  } catch {
    /* observability must never break retrieval */
  }
}

/**
 * Rerank `docs`, returning items paired with scores. Falls back to input order with
 * synthetic descending scores (1, 0.99, 0.98, ...) when the reranker is absent, empty, or
 * throws — so callers always get a usable number and retrieval never fails on rerank.
 *
 * `onOutcome`, when provided, is reported exactly once per call with WHY the returned
 * ranking is what it is (see RerankOutcome). Purely additive — omitting it changes nothing.
 */
export async function rerankWithScores<T extends RankableDoc>(
  query: string,
  docs: T[],
  topN: number,
  reranker: Reranker | null | undefined,
  onOutcome?: OnRerankOutcome,
  timeoutMs: number | undefined = DEFAULT_RERANK_TIMEOUT_MS,
  /** THE-934 fix round 1 (I2): egress.excludePaths, compiled. Undefined -> nothing excluded. */
  excludeFilter?: EgressFilter,
): Promise<Array<{ item: T; score: number }>> {
  const fallback = (): Array<{ item: T; score: number }> =>
    docs.slice(0, topN).map((item, i) => ({ item, score: 1 - i * 0.01 }));

  if (!reranker) {
    reportRerankOutcome(onOutcome, "not_configured");
    return fallback();
  }
  if (docs.length === 0) {
    reportRerankOutcome(onOutcome, "fallback_used");
    return fallback();
  }
  // THE-934 fix round 1 (I2): split BEFORE the reranker ever sees anything — a hosted reranker is
  // a content-bearing egress leg exactly like extract/synthesize/judge, and an excluded doc's
  // TEXT must never reach it. An excluded doc keeps the SAME synthetic fusion-order score the
  // plain fallback() above already uses (never reordered by the model) and is spliced back in
  // after the real reranker call below.
  const excludedIdx = new Set<number>();
  if (excludeFilter !== undefined) {
    docs.forEach((d, i) => {
      if (isExcludedPath(excludeFilter, d.path)) excludedIdx.add(i);
    });
  }
  const excludedScored: Array<{ item: T; score: number }> = [...excludedIdx].map((i) => ({
    item: docs[i] as T,
    score: 1 - i * 0.01,
  }));
  const keep = docs.filter((_, i) => !excludedIdx.has(i));
  if (keep.length === 0) {
    // Every candidate was excluded — nothing left that may reach the reranker at all.
    reportRerankOutcome(onOutcome, "fallback_used");
    return excludedScored.slice(0, topN);
  }
  try {
    const call = reranker(
      query,
      keep.map((d) => d.content),
      Math.min(topN, keep.length),
      // THE-934: the egress guard's backstop check — every path here already cleared the filter.
      keep.map((d) => d.path),
    );
    // No timeout unless the caller asked for one — see DEFAULT_RERANK_TIMEOUT_MS above. Awaiting
    // the bare promise keeps the pre-change bound (provider/gateway budget) exactly as it was.
    const hits = timeoutMs === undefined ? await call : await withTimeout(call, timeoutMs);
    const out: Array<{ item: T; score: number }> = [];
    for (const h of hits) {
      const item = keep[h.index];
      if (item !== undefined) out.push({ item, score: h.relevanceScore });
    }
    // Sorted explicitly rather than trusting the provider's response order — most rerank APIs
    // already return descending-by-relevance, but nothing here is entitled to assume that of an
    // arbitrary Reranker implementation (the local package, a module-hatch reranker, ...).
    out.sort((a, b) => b.score - a.score);
    if (out.length > 0) {
      reportRerankOutcome(onOutcome, "executed");
      // THE-934 fix round 2 (N4): APPENDED after the reranked set, in original fusion order — NOT
      // merged by score comparison. Round 1 sorted the union by score, which put excluded docs
      // (synthetic scores starting at 1.0, decaying by 0.01) ahead of essentially every REAL
      // cross-encoder relevance score, so turning exclusion ON systematically PROMOTED the
      // excluded folder to the top of every reranked search — the opposite of what an operator
      // enabling exclusion would expect, and strictly worse than merely "interleaved". There is no
      // principled common scale between an opaque, vendor/model-specific relevance score and a
      // synthetic index-based fallback score, so comparing them numerically is unsound regardless
      // of the scale chosen; appending is the one merge rule that is correct BY CONSTRUCTION,
      // never by a scale that happens to work for today's reranker. `out` is already sorted
      // descending by the reranker's own score; `excludedScored` stays in the fusion (input)
      // order it was collected in, never reordered by a model that never saw it.
      //
      // Follow-up (NB3): append alone only holds THIS return's order — the excluded score FIELD
      // still carried the synthetic fallback (~1.0), above most real scores on paper, so a later
      // re-sort (activationRerank's bubbleSafeRerank, ships false) could still promote one.
      // Rescaling below the reranked floor makes that unrepresentable by the number itself.
      const floor = Math.min(...out.map((o) => o.score));
      const rescaledExcluded = excludedScored.map((e, i) => ({
        item: e.item,
        score: floor - 0.0001 * (i + 1),
      }));
      return [...out, ...rescaledExcluded].slice(0, topN);
    }
    // Non-empty docs but no usable hit (empty response, or every index out of range): a working
    // reranker call has no legitimate reason to say nothing about a non-empty candidate set, so
    // this is treated as malformed rather than a genuine "no results" answer.
    reportRerankOutcome(onOutcome, "malformed_response");
    return fallback();
  } catch (e) {
    reportRerankOutcome(
      onOutcome,
      e instanceof RerankTimeoutError ? "timed_out" : "provider_error",
    );
    return fallback();
  }
}
