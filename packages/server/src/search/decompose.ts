// THE-651 — sub-question decomposition, the half that runs ONLY on a multi-hop route.
//
// THE-448 measured UNCONDITIONAL query fan-out at −0.047 nDCG@10 (p=0.0004). That result stands
// and this module must not repeat it. The literature's stated fix is not a better decomposer, it
// is a classifier in FRONT of one:
//
//   "an LLM asked to decompose will happily split a single-hop question into three redundant
//    sub-queries, tripling retrieval cost for no gain … a small classifier can decide whether a
//    question is single-hop or multi-hop before reaching for the decomposer"
//
// So the conditioning is the mechanism under test, and it lives in `router.ts` (the `multi_hop`
// class, placed last so it can only claim queries that would otherwise be `standard`). This file
// is only reached once that decision is made.
//
// WHY THE GATEWAY AND NOT A DETERMINISTIC SPLIT. The classifier is deterministic on purpose — a
// classifier that needed an LLM call to decide whether to make an LLM call would spend exactly the
// latency the conditioning exists to save. Decomposition itself cannot be: "how does X inform Y"
// has to become two questions that name X and Y, which is generation. It goes through the
// `extract` role like every other generative call here, so it inherits the gateway's tracing and
// key handling rather than opening a second HTTP path.
import type { GatewayRoles } from "../plane/gateway";

/** Hard ceiling on sub-questions. THE-448's cost objection is per sub-query — N sub-questions is N
 *  retrievals — and an uncapped decomposer is how "conditional" quietly becomes "expensive". Three
 *  is the shape the multi-hop corpus takes (a seed domain, a target domain, and the link). */
export const MAX_SUB_QUESTIONS = 3;

const SYSTEM =
  "You split a multi-hop research question into independent sub-questions that can each be " +
  "answered by retrieving from one place. Output ONLY the sub-questions, one per line, no " +
  "numbering, no prose, no preamble. Emit at most " +
  String(MAX_SUB_QUESTIONS) +
  ". If the question is already single-hop, emit it unchanged as the only line.";

/**
 * Parse the model's reply into sub-questions.
 *
 * Exported and pure so the parse is testable without a gateway. Tolerant of the shapes a reasoning
 * model actually emits — numbered lists, bullets, stray blank lines — because the alternative is a
 * parse failure that silently degrades to "no decomposition" and shows up as a null in the A/B
 * rather than as an error.
 */
export function parseSubQuestions(text: string, original: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0 && l.length <= 400);
  // Deduped case-insensitively: a decomposer that returns the same sub-question twice would
  // double-weight that arm of the fusion, which reads as a ranking effect and is not one.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const k = l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
    if (out.length >= MAX_SUB_QUESTIONS) break;
  }
  // A decomposition that produced nothing usable is NOT an error and must not throw: the honest
  // fallback is the original query, which makes the arm degrade to the control rather than to a
  // hole in the result set. `run.ts` reports how often this happened so a high rate cannot hide
  // inside a null.
  return out.length > 0 ? out : [original];
}

export interface DecomposeResult {
  subQuestions: string[];
  /** True when the model gave nothing usable and the original was substituted. Counted by the
   *  caller: a decomposition arm where this is common is measuring the fallback, not the idea. */
  fellBack: boolean;
}

/**
 * Decompose one multi-hop query. Never throws — a gateway failure degrades to the original query
 * for the same reason a bad parse does.
 *
 * `maxTokens` is deliberately generous: the `extract` role resolves to a reasoning model, and a
 * measured two-line answer consumed 396 completion tokens with 13 of the first 16 spent before any
 * text appeared. A tight budget here does not save money, it returns `content: null` with
 * `finish_reason: "length"` and looks exactly like a model that had nothing to say.
 */
export async function decomposeQuery(roles: GatewayRoles, query: string): Promise<DecomposeResult> {
  try {
    const res = await roles.extract({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: query },
      ],
      temperature: 0,
      maxTokens: 1200,
    });
    const subQuestions = parseSubQuestions(res.text ?? "", query);
    return { subQuestions, fellBack: subQuestions.length === 1 && subQuestions[0] === query };
  } catch {
    return { subQuestions: [query], fellBack: true };
  }
}

/**
 * Reciprocal-rank fusion over per-sub-question result lists.
 *
 * The SAME RRF the retrieval streams already use, and the same `k`, so the decomposed arm and the
 * control return the same UNIT — the trap this ticket names explicitly: *"If the decomposed arm
 * merges and dedups while the control returns chunks, the dedup gets credited to decomposition."*
 * A single-element input therefore has to come back in its original order, which is what makes the
 * single-hop path byte-identical rather than merely similar.
 */
export function fuseRanked<T>(
  lists: readonly (readonly T[])[],
  key: (item: T) => string,
  k = 60,
): T[] {
  if (lists.length === 1) return [...(lists[0] ?? [])];
  const score = new Map<string, number>();
  const first = new Map<string, T>();
  for (const list of lists) {
    list.forEach((item, i) => {
      const id = key(item);
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
      if (!first.has(id)) first.set(id, item);
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => first.get(id))
    .filter((v): v is T => v !== undefined);
}
