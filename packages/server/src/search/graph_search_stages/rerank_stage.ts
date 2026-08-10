// THE-465 "gatedRerank" stage: THE-394's hard-query gate for the graph_rrf/convex path. Moved
// verbatim out of graphSearchCore's tail — same hardness rule (z-margin when hardZ is set,
// absolute top-1 cosine otherwise), same pool default (20), same non-reranked-tail ordering.
// Falls through to the plain (optionally bubble-safe) projection when the gate does not fire —
// same as before the THE-465 extraction, just named as one stage instead of an inline branch.
import { reportRerankOutcome, rerankWithScores } from "../rerank";
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
 *  (with the optional bubble-safe activation composition still applied).
 *
 *  every branch that returns WITHOUT calling rerankWithScores reports its own outcome —
 *  rerankWithScores can only report what happens INSIDE the call it is given, so "the gate is off"
 *  and "reranking is unconfigured" would otherwise be silently indistinguishable from "the gate
 *  fired and the call happened", exactly the blind spot this closes. Purely additive: no branch's
 *  return value changes. */
export async function applyGatedRerank(input: GatedRerankInput): Promise<GraphSearchResult[]> {
  const { opts, capped, seeds, zMargin, routedToSeedsOnly, scoreOfWithPrior } = input;
  const gr = opts.gatedRerank;
  if (gr?.enabled ?? false) {
    if (!opts.reranker) {
      reportRerankOutcome(opts.onRerankOutcome, "not_configured");
    } else {
      const top1 = seeds[0]?.score ?? 0;
      // THE-400: hardZ (z-margin mode) replaces the absolute-cosine hardness rule when set.
      const hard = gr?.hardZ !== undefined ? zMargin < gr.hardZ : top1 < (gr?.hardTop1 ?? 0.55);
      if (!routedToSeedsOnly && hard) {
        const head = capped.slice(0, Math.min(gr?.pool ?? 20, capped.length));
        const ranked = await rerankWithScores(
          opts.query,
          head,
          head.length,
          opts.reranker,
          opts.onRerankOutcome,
        );
        const rerankedIds = new Set(ranked.map((r) => r.item.chunk_id));
        const rest = capped.filter((c) => !rerankedIds.has(c.chunk_id));
        return [
          ...ranked.map(({ item, score }) => toResult(item, score)),
          ...rest.map((c) => toResult(c, scoreOfWithPrior(c))),
        ];
      }
      // Reranker is configured and the gate is on, but this query didn't qualify as hard: a
      // deliberate policy decision, not an absence or a failure.
      reportRerankOutcome(opts.onRerankOutcome, "skipped_by_policy");
    }
  }
  return projectWithBubbleSafe(capped, scoreOfWithPrior, opts);
}

/** Used only when a caller threads no hardness block — real configs always carry one, because the
 *  schema `.prefault({})`s it, so in practice only fixtures land here. These values MUST equal the
 *  schema's defaults; `gated-rerank-hardness-config.test.ts` asserts that by parsing the schema and
 *  comparing, so the two cannot drift into disagreeing about what "the default gate" means. */
const GATED_RERANK_HARDNESS_FALLBACK = {
  mode: "cosine",
  hardTop1: 0.55,
  hardZ: 1.0,
  pool: 20,
} as const;

/** THE-806: build the `gatedRerank` options from config, so production and the eval harness can
 *  construct the SAME object.
 *
 *  Before this, production sent `{ enabled: true }` — leaving both knobs undefined and therefore
 *  always taking the cosine branch in `applyGatedRerank` above — while `eval/run.ts` sent `hardZ`,
 *  always taking the z-margin branch. Neither arm could reach the other's rule, so any golden-set
 *  result for `--gated-rerank` measured a gate production cannot execute.
 *
 *  Exactly ONE knob is emitted, chosen by `mode`. That is deliberate: the gate keys on
 *  `hardZ !== undefined`, so emitting both would make `hardTop1` permanently unreachable and turn
 *  a config value into a decoration. */
export function gatedRerankOptionsFromConfig(hardness?: {
  mode: "cosine" | "zMargin";
  hardTop1: number;
  hardZ: number;
  pool: number;
}): NonNullable<GraphSearchOptions["gatedRerank"]> {
  const h = hardness ?? GATED_RERANK_HARDNESS_FALLBACK;
  return {
    enabled: true,
    pool: h.pool,
    ...(h.mode === "zMargin" ? { hardZ: h.hardZ } : { hardTop1: h.hardTop1 }),
  };
}
