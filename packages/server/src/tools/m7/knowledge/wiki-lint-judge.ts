// The judge step of lint_wiki and the scheduled wiki lint: ask the wiki judge about the near-duplicate
// proposals (note pairs whose vectors are close) and put each verdict on its proposal. Advisory like
// the rest of lint: a proposal is never dropped or reordered, a pair that cannot be judged (excluded,
// unreadable, over budget, a failed call) keeps its proposal unchanged, and nothing is written.
import { z } from "zod";
import type { EgressFilter } from "../../../plane/egress-filter";
import { loadSendable, type SendScope, type WikiJudge, type WikiJudgeVerdict } from "./wiki-judge";
import type { LintReport } from "./wiki-lint";

export const PairJudgeReportSchema = z.object({
  ran: z.boolean(),
  /** Why it did not run (no gateway, no near-duplicate pairs). */
  reason: z.string().optional(),
  /** Resolved model that ruled, never the gateway alias. */
  model: z.string().optional(),
  /** Gateway calls made now / verdicts served from the cache. */
  calls: z.number().int(),
  cached: z.number().int(),
  by_verdict: z.record(z.string(), z.number().int()),
  /** Pairs left unjudged: refused (excluded / unreadable), over the budget, or a failed call. */
  unjudged: z.number().int(),
});
export type PairJudgeReport = z.infer<typeof PairJudgeReportSchema>;

export const DEFAULT_LINT_JUDGE_CALLS = 10;
const CONCURRENCY = 4;

const ACTION: Record<WikiJudgeVerdict, string> = {
  same_topic:
    "The judge ruled these the same topic. Read both, keep one page, fold the other's unique content into it, and re-point links to the survivor with rewrite_link.",
  overlapping:
    "The judge ruled these overlapping, not the same. Read both: link them to each other, or move the shared part into one page.",
  different:
    "The judge ruled these different topics despite the close vectors. Leave both unless reading them says otherwise.",
};

export function noPairJudge(reason: string): PairJudgeReport {
  return { ran: false, reason, calls: 0, cached: 0, by_verdict: {}, unjudged: 0 };
}

/**
 * Judge the near_duplicate proposals of `report` (highest similarity first, as lint orders them),
 * spending at most `maxCalls` gateway calls. Cached verdicts are free. Mutates the proposals it
 * rules on: `evidence.judge`, and `detail` / `suggested_action` to say what the judge found.
 */
export async function judgeNearDuplicates(
  report: LintReport,
  judge: WikiJudge,
  scope: SendScope,
  excludeFilter: EgressFilter | undefined,
  maxCalls: number,
): Promise<PairJudgeReport> {
  if (!judge.available)
    return noPairJudge(
      "no judge is available: it needs a configured judge (a gateway, or wikiJudge.provider typesafe) and wikiJudge.maxCallsPerDay above 0",
    );
  const pairs = report.proposals.filter((p) => p.kind === "near_duplicate" && p.related?.[0]);
  if (pairs.length === 0) return noPairJudge("no near-duplicate pairs to judge");

  const out: PairJudgeReport = { ran: true, calls: 0, cached: 0, by_verdict: {}, unjudged: 0 };
  const budget = judge.newBudget(maxCalls);
  const reasons = new Set<string>();
  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    await Promise.all(
      pairs.slice(i, i + CONCURRENCY).map(async (p) => {
        const a = loadSendable(scope, excludeFilter, p.subject);
        const b = loadSendable(scope, excludeFilter, p.related?.[0] as string);
        if (!("note" in a) || !("note" in b)) {
          out.unjudged++;
          reasons.add("refused");
          return;
        }
        const o = await judge.judgePair(a.note, b.note, budget);
        if (!o.ok) {
          out.unjudged++;
          reasons.add(o.reason);
          return;
        }
        if (o.cached) out.cached++;
        else out.calls++;
        out.model ??= o.model;
        out.by_verdict[o.verdict] = (out.by_verdict[o.verdict] ?? 0) + 1;
        p.evidence = {
          ...p.evidence,
          judge: { verdict: o.verdict, rationale: o.rationale, model: o.model, cached: o.cached },
        };
        p.detail = `${p.detail ?? ""} Judge (${o.model}): ${o.verdict}: ${o.rationale}`.trim();
        p.suggested_action = ACTION[o.verdict];
      }),
    );
  }
  if (out.unjudged > 0)
    report.notes.push(
      `near_duplicates: ${out.unjudged} pair(s) were not judged (${[...reasons].sort().join(", ")}).`,
    );
  return out;
}
