// THE-465 "gatedRerank" stage: THE-394's hard-query gate for the graph_rrf/convex path. Moved
// verbatim out of graphSearchCore's tail — same hardness rule (z-margin when hardZ is set,
// absolute top-1 cosine otherwise), same pool default (20), same non-reranked-tail ordering.
// Falls through to the plain (optionally bubble-safe) projection when the gate does not fire —
// same as before the THE-465 extraction, just named as one stage instead of an inline branch.
import { rerankWithScores } from "../rerank";
import type { SemanticHit } from "../semantic";
import { projectWithBubbleSafe, toResult } from "./projection";
import type { Candidate, GraphSearchOptions, GraphSearchResult } from "./types";

export interface GatedRerankInput {
  opts: GraphSearchOptions;
  capped: Candidate[];
  seeds: SemanticHit[];
  zMargin: number;
  routedToSeedsOnly: boolean;
  scoreOfWithPrior: (c: Candidate) => number;
}

/** THE-394: hard-query gate — rerank the head of the fused list only when the dense seeds were
 *  weak (router silent + low top-1 cosine); everything else returns pure RRF/convex order
 *  (with the optional bubble-safe activation composition still applied). */
export async function applyGatedRerank(input: GatedRerankInput): Promise<GraphSearchResult[]> {
  const { opts, capped, seeds, zMargin, routedToSeedsOnly, scoreOfWithPrior } = input;
  const gr = opts.gatedRerank;
  if ((gr?.enabled ?? false) && opts.reranker) {
    const top1 = seeds[0]?.score ?? 0;
    // THE-400: hardZ (z-margin mode) replaces the absolute-cosine hardness rule when set.
    const hard = gr?.hardZ !== undefined ? zMargin < gr.hardZ : top1 < (gr?.hardTop1 ?? 0.55);
    if (!routedToSeedsOnly && hard) {
      const head = capped.slice(0, Math.min(gr?.pool ?? 20, capped.length));
      const ranked = await rerankWithScores(opts.query, head, head.length, opts.reranker);
      const rerankedIds = new Set(ranked.map((r) => r.item.chunk_id));
      const rest = capped.filter((c) => !rerankedIds.has(c.chunk_id));
      return [
        ...ranked.map(({ item, score }) => toResult(item, score)),
        ...rest.map((c) => toResult(c, scoreOfWithPrior(c))),
      ];
    }
  }
  return projectWithBubbleSafe(capped, scoreOfWithPrior, opts);
}
