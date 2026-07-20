/**
 * v1.2 chunk activation, sub-decision F: BubbleRank-style safety constraint.
 * Ported from knowledge-mcp-server lib/bubble_safe_rerank.ts (THE-233 W-RETRIEVAL).
 *
 * Activation enters AFTER rerank as a bounded multiplier on the rerank score; the final
 * order may differ from the reranker's by at most ONE position per item (adjacent swaps
 * only). Worst case if activation learned something wrong: one pair of neighbors swaps.
 * The reranker stays ground truth.
 *
 *   multiplier = 1 + (activation - 0.5) * 0.4
 *     0.5 (no info / cold start) -> 1.0x (provably inert); 1.0 -> 1.2x; 0.0 -> 0.8x.
 *
 * Activation scores come from vault_object_state (the experiential store, W-SCHEMA); this
 * pure function takes them as input and is inert (multiplier 1.0) when they are absent.
 *
 * The multiplier range `k` is tunable (default ACTIVATION_MULTIPLIER_RANGE). The primitive is
 * signal-agnostic: it folds ANY experimental per-item signal in [0,1] into a trusted order the
 * same way — the same bounded-multiplier + single-bubble-pass composition ALSO backs a
 * metadata-prior signal (wired in a separate PR); here it is used only for the activation signal.
 */

export interface RankableWithActivation {
  /** Reranker relevance score (or synthetic fallback score) — the TRUSTED order. */
  rerankScore: number;
  /** cached_activation_score from vault_object_state; undefined/null -> 0.5 (inert). */
  activationScore?: number | null;
}

export const ACTIVATION_MULTIPLIER_RANGE = 0.4;

export interface BubbleSafeOpts {
  /** Multiplier range: the signal folds in as `1 + (signal - 0.5) * k`, so it is INERT at
   *  signal=0.5 for any k. Defaults to ACTIVATION_MULTIPLIER_RANGE (0.4). */
  k?: number;
}

export function activationMultiplier(
  activation: number | null | undefined,
  k: number = ACTIVATION_MULTIPLIER_RANGE,
): number {
  const a = activation ?? 0.5;
  return 1 + (a - 0.5) * k;
}

/**
 * One bubble pass over the rerank ordering: a pair (i, i+1) swaps when the adjusted score
 * of i+1 strictly exceeds that of i AND neither item has already moved. Single pass + the
 * moved-flag guarantees |final - original| <= 1 for every item (one adjacent swap per item,
 * worst case). Does NOT mutate the input; returns a new array.
 */
export function bubbleSafeRerank<T extends RankableWithActivation>(
  items: T[],
  opts: BubbleSafeOpts = {},
): T[] {
  const k = opts.k ?? ACTIVATION_MULTIPLIER_RANGE;
  const out = items.slice();
  const moved = new Array<boolean>(out.length).fill(false);

  for (let i = 0; i < out.length - 1; i++) {
    if (moved[i] || moved[i + 1]) continue;
    const a = out[i];
    const b = out[i + 1];
    if (a === undefined || b === undefined) continue;
    const adjA = a.rerankScore * activationMultiplier(a.activationScore, k);
    const adjB = b.rerankScore * activationMultiplier(b.activationScore, k);
    if (adjB > adjA) {
      out[i] = b;
      out[i + 1] = a;
      moved[i] = true;
      moved[i + 1] = true;
    }
  }
  return out;
}
