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
 * THE-668: that fallback is deliberately silent about WHY it fired — "not configured",
 * "policy skipped it", "it timed out", "it returned garbage", and "it genuinely produced
 * this order" were all indistinguishable from the caller's side. `RerankOutcome` +
 * `onOutcome` close that gap additively: the return shape and the fallback SCORES are
 * unchanged for every existing caller, this only adds a best-effort side-channel report.
 */

export interface RerankHit {
  index: number;
  relevanceScore: number;
}

/** Scores documents against a query, returning hits by descending relevance. */
export type Reranker = (query: string, documents: string[], topN: number) => Promise<RerankHit[]>;

export interface RankableDoc {
  content: string;
}

/** THE-668: the reason `rerankWithScores` returned what it returned, reported through `onOutcome`
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

/** THE-668: reranking is a bounded round-trip over an already-hydrated candidate set (unlike the
 *  embedding provider's batch calls), so a tighter budget than embeddings/http.ts's 30s default is
 *  appropriate. Exceeded -> "timed_out", distinct from a provider that answers with an error. */
const DEFAULT_RERANK_TIMEOUT_MS = 10_000;

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
 * THE-668: `onOutcome`, when provided, is reported exactly once per call with WHY the returned
 * ranking is what it is (see RerankOutcome). Purely additive — omitting it changes nothing.
 */
export async function rerankWithScores<T extends RankableDoc>(
  query: string,
  docs: T[],
  topN: number,
  reranker: Reranker | null | undefined,
  onOutcome?: OnRerankOutcome,
  timeoutMs: number = DEFAULT_RERANK_TIMEOUT_MS,
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
  try {
    const hits = await withTimeout(
      reranker(
        query,
        docs.map((d) => d.content),
        topN,
      ),
      timeoutMs,
    );
    const out: Array<{ item: T; score: number }> = [];
    for (const h of hits) {
      const item = docs[h.index];
      if (item !== undefined) out.push({ item, score: h.relevanceScore });
    }
    if (out.length > 0) {
      reportRerankOutcome(onOutcome, "executed");
      return out;
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
