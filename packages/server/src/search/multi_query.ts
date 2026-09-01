// THE-448: multi-query fan-out fusion — RRF over query-VARIANT results.
//
// This is a DIFFERENT fusion layer from graph_search's existing in-query RRF (the `rrf` scorer in
// graph_search_stages/fusion.ts's fuseScores), which fuses multiple STREAMS (seed/lexical/sparse/
// expansion/temporal) produced by ONE graphSearch call. Here, each element of `queries` is a full
// alternate phrasing of the same search intent; it gets its OWN complete graphSearch call (all of
// graphSearch's own internal stream fusion happens per variant, unchanged), and the per-variant
// RANKED LISTS are fused across variants by Reciprocal Rank Fusion on RANK POSITION, never on
// `rerank_score`: graph_search's convex fusion min-max-normalizes raw scores over a SINGLE query's
// own candidate pool (fuseScores' `minMaxNorm` calls in graph_search_stages/fusion.ts), so a 0.8 in
// variant A's pool and a 0.8 in variant B's pool are not the same evidence strength. Rank is
// comparable across variants by construction — RRF fuses on rank for exactly this reason — so
// scoring on rank sidesteps the cross-variant normalization mismatch entirely.
//
// Deliberately does NOT vary the embedding vector per variant: `queries` are alternate query
// TEXT, run against the SAME opts.queryVec. graphSearch reads opts.query (not just opts.queryVec)
// for several independent signals — the BM25 lexical stream, temporal-intent parsing, adaptive-RRF
// specificity, and cross-encoder rerank text — so distinct phrasings genuinely change the fused
// per-variant ranking without requiring a per-variant embedding call (out of scope here: this
// module has no embedding provider, and re-embedding N phrasings per query is a separate,
// heavier design point left to a follow-up).
//
// Opt-in and off by default: this is a new, standalone entry point above graphSearch (never
// wired into graphSearch itself, and not yet exposed on any tool's Zod schema — see THE-448
// follow-up). Absent/empty/single-element `queries` is an EXACT no-op, delegating straight to
// graphSearch with no fan-out, no over-fetch, and no fusion pass.
import { isLoudRefusal } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";
import { runWithConcurrency } from "../util/concurrency";
import { type GraphSearchOptions, type GraphSearchResult, graphSearch } from "./graph_search";

/** THE-448 fan-out tuning — nested optional object, off-by-default convention (graph_search.ts's
 *  graphStream/smoothExpansion/etc. shape), even though the fan-out itself is gated by `queries`
 *  having 2+ elements rather than an `enabled` flag: these are DEPTH/CONCURRENCY knobs, not a
 *  behavior toggle. */
export interface MultiQueryFanOutOptions {
  /** Max simultaneous graphSearch calls across variants. Default 3. */
  concurrency?: number;
  /** RRF k for the ACROSS-variant fusion (rank-based). Defaults to 10 — the same default as
   *  graph_search's own in-query rrfK (graphSearchCore's `opts.rrfK ?? 10` in graph_search.ts),
   *  for tuning consistency between the two fusion layers; independently overridable since the
   *  two pools have different shapes (in-query streams vs. per-variant full result lists). */
  rrfK?: number;
}

export interface MultiQueryGraphSearchOptions extends GraphSearchOptions {
  multiQueryFanOut?: MultiQueryFanOutOptions;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_FAN_OUT_RRF_K = 10;
// Mirrors graph_search.ts's own `opts.finalTopK ?? 30` (graphSearchCore). Not imported because
// graph_search.ts does not export it and this ticket keeps graph_search.ts untouched.
const DEFAULT_FINAL_TOP_K = 30;

/** THE-926: why a variant contributed nothing to the fused result, reported through
 *  `onVariantOutcome` (mirrors search/rerank.ts's `RerankOutcome`/`onOutcome` shape) — "swallowed
 *  a transient error" is otherwise indistinguishable from "the search genuinely found nothing". */
export type VariantOutcome = "ok" | "swallowed_error";

export interface VariantOutcomeEvent {
  index: number;
  query: string;
  outcome: VariantOutcome;
}

export type OnVariantOutcome = (event: VariantOutcomeEvent) => void;

/** Best-effort report, same guard as rerank.ts's `reportRerankOutcome`: a throwing sink must
 *  never affect the fan-out it is observing. */
function reportVariantOutcome(
  onVariantOutcome: OnVariantOutcome | undefined,
  event: VariantOutcomeEvent,
): void {
  try {
    onVariantOutcome?.(event);
  } catch {
    /* observability must never break retrieval */
  }
}

/**
 * Fan out ONE query into several phrasing variants, run graphSearch per variant (bounded
 * concurrency, default limit 3), and fuse the per-variant ranked lists by rank-based RRF,
 * deduping by `path` and keeping the best (highest-ranked) hit per path. A variant that returns no
 * results simply contributes nothing — it never fails the whole fan-out. Nor does a variant that
 * throws a genuinely transient error (`onVariantOutcome` reports it as `"swallowed_error"` when
 * supplied) — but THE-926: a variant whose `graphSearch` call threw a deliberate, structural
 * refusal (e.g. chunk_fts.ts's THE-750 guard) is NOT swallowed — `isLoudRefusal` (see the shared
 * error taxonomy) rethrows it, failing the whole call loudly rather than silently returning fewer
 * results for a reason the caller can never see.
 *
 * `queries` absent, empty, or a single element is an EXACT no-op: delegates straight to
 * graphSearch (unmodified opts for absent/empty; only `query` swapped for a single element,
 * `finalTopK` untouched) with no over-fetch and no fusion pass.
 */
export async function multiQueryGraphSearch(
  db: Database,
  opts: MultiQueryGraphSearchOptions,
  queries?: string[],
  onVariantOutcome?: OnVariantOutcome,
): Promise<GraphSearchResult[]> {
  if (!queries || queries.length === 0) return graphSearch(db, opts);
  if (queries.length === 1) return graphSearch(db, { ...opts, query: queries[0] as string });

  const finalTopK = opts.finalTopK ?? DEFAULT_FINAL_TOP_K;
  // Over-fetch per variant so the cross-variant fusion has depth to work with — a variant whose
  // top hit ranks #1 there but is absent from the other variants must still be visible to RRF
  // even after the OTHER variants' hits interleave ahead of it in the fused order.
  const perQueryK = Math.max(finalTopK * 2, finalTopK + 10);
  const concurrency = Math.max(1, opts.multiQueryFanOut?.concurrency ?? DEFAULT_CONCURRENCY);
  const rrfK = opts.multiQueryFanOut?.rrfK ?? DEFAULT_FAN_OUT_RRF_K;

  const perVariantResults = await runWithConcurrency(
    queries,
    concurrency,
    async (variantQuery, index) => {
      try {
        const results = await graphSearch(db, {
          ...opts,
          query: variantQuery,
          finalTopK: perQueryK,
        });
        reportVariantOutcome(onVariantOutcome, { index, query: variantQuery, outcome: "ok" });
        return results;
      } catch (e) {
        // THE-926: a deliberate/structural refusal must fail the whole call loudly, not be
        // swallowed as "this variant found nothing" — see isLoudRefusal's doc comment.
        if (isLoudRefusal(e)) throw e;
        // A single bad variant (transient error, degenerate phrasing) must not sink the others.
        reportVariantOutcome(onVariantOutcome, {
          index,
          query: variantQuery,
          outcome: "swallowed_error",
        });
        return [] as GraphSearchResult[];
      }
    },
  );

  return fuseVariants(perVariantResults, rrfK, finalTopK);
}

/**
 * Fuse several variants' RANKED result lists by Reciprocal Rank Fusion on rank position: each
 * candidate's score is Σ over the variants it appears in of 1/(rrfK + rank-in-that-variant)
 * (rank is 1-based, matching graph_search.ts's own rrf convention). Dedupes by `path`, keeping the
 * result object from whichever variant ranked it best (smallest rank number); the fused score
 * still accumulates contributions from every variant the path appears in. Exported standalone so
 * the fusion math is unit-testable without a live DB or graphSearch call.
 */
export function fuseVariants(
  perVariantResults: GraphSearchResult[][],
  rrfK: number,
  finalTopK: number,
): GraphSearchResult[] {
  const byPath = new Map<string, { result: GraphSearchResult; bestRank: number; score: number }>();
  for (const variant of perVariantResults) {
    variant.forEach((r, i) => {
      const rank = i + 1;
      const contribution = 1 / (rrfK + rank);
      const existing = byPath.get(r.path);
      if (!existing) {
        byPath.set(r.path, { result: r, bestRank: rank, score: contribution });
      } else {
        existing.score += contribution;
        if (rank < existing.bestRank) {
          existing.result = r;
          existing.bestRank = rank;
        }
      }
    });
  }
  return [...byPath.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, finalTopK)
    .map((e) => e.result);
}
