// knowledge_challenge generative core — THE-233 W-WORKERS. Ports the red-team logic onto the
// gateway `judge` seam. The evidence-gathering (vault_search retrieval + isDecisionChunk
// filter) and the MCP tool registration are INTEGRATION-GATED — they need retrieval on main —
// so this module is the decoupled, testable generative core: prompt + call + parse, plus the
// pure isDecisionChunk classifier. knowledge_get_critical is NOT ported: it queries a KMS
// vendor-KB (knowledge_chunks: severity/mcp_name) data model the converged vault-centric tree
// does not have; it stays integration-gated (THE-233 integration follow-up).
import { z } from "zod";
import { renderEvidenceItem, trimToBoundary } from "../search/evidence";
import { type EgressFilter, isExcludedPath } from "./egress-filter";
import { type GatewayRoles, prompt } from "./gateway";

const DECISION_PATH_PREFIXES = [
  "02-projects/",
  "04-writing/Published/",
  "09-reference/system-reviews/",
  "09-reference/syntheses/",
];
const DECISION_TAGS = new Set([
  "decision",
  "audit",
  "self-audit",
  "outcome",
  "postmortem",
  "reversal",
  "lesson",
  "review",
  "analysis",
]);

/** A vault chunk is decision-bearing if its path is under a decision folder or it is tagged. */
export function isDecisionChunk(hit: { path: string; tags?: string[] | null }): boolean {
  if (DECISION_PATH_PREFIXES.some((p) => hit.path.startsWith(p))) return true;
  return hit.tags?.some((t) => DECISION_TAGS.has(t)) ?? false;
}

export interface EvidenceChunk {
  path: string;
  headings?: string[] | null;
  tags?: string[] | null;
  content: string;
}
export interface ContradictionContext {
  id: string;
  source_path: string;
  conflict_path: string;
  judge_verdict: string;
  judge_rationale: string;
}

const CHALLENGE_SYSTEM_PROMPT = `You are a red-team analyst auditing a proposal against the user's documented decision history.

Your job: identify, with specificity, where the proposal conflicts with the past evidence. You are NOT a cheerleader. If the proposal is sound, say so. If it isn't, push back with citations.

Four categories to consider:
  - DIRECT_CONTRADICTION: past evidence factually negates the proposal.
  - PATTERN_REPEAT: this proposal would re-walk a documented failure.
  - REVERSAL: a similar prior decision was reversed; explain why and whether conditions changed.
  - HIDDEN_DEPENDENCY: the proposal assumes something past work has not validated.

Cite evidence by path. Omit a category entirely if it has nothing. If no genuine challenge exists, output an empty categories array — do not invent objections.

Output STRICT JSON only. No prose, no code fences. Schema:
{"verdict":"proceed"|"reconsider"|"do_not_proceed","summary":"<one sentence>","categories":[{"kind":"DIRECT_CONTRADICTION"|"PATTERN_REPEAT"|"REVERSAL"|"HIDDEN_DEPENDENCY","items":[{"evidence_paths":["..."],"why_it_matters":"...","severity":"high"|"medium"|"low"}]}]}`;

// THE-417: exported so the two tools that RETURN a ChallengeOutput (reflect, knowledge_challenge)
// advertise the same schema the parser enforces, rather than a hand-copied restatement of it.
export const challengeOutputSchema = z.object({
  verdict: z.enum(["proceed", "reconsider", "do_not_proceed"]),
  summary: z.string().min(1),
  categories: z.array(
    z.object({
      kind: z.enum(["DIRECT_CONTRADICTION", "PATTERN_REPEAT", "REVERSAL", "HIDDEN_DEPENDENCY"]),
      items: z.array(
        z.object({
          evidence_paths: z.array(z.string()),
          why_it_matters: z.string().min(1),
          severity: z.enum(["high", "medium", "low"]),
        }),
      ),
    }),
  ),
});

export type ChallengeOutput = z.infer<typeof challengeOutputSchema>;

export function parseChallengeOutput(raw: string): ChallengeOutput {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  return challengeOutputSchema.parse(JSON.parse(stripped));
}

/** Per-item truncation for the challenge prompt. Exported so the callers that assemble evidence for
 *  it build to the same cap instead of inventing their own — see CHALLENGE_EVIDENCE_BUDGET in
 *  tools/m7/knowledge/retrieval-runtime.ts, which composes this with CHALLENGE_RECALL.
 *
 *  The budget lives THERE and not here on purpose: `tools/` already imports this module
 *  (challengeProposal), so importing CHALLENGE_RECALL back the other way would close a
 *  plane -> tools -> plane cycle, and this repo's no-circular baseline is zero. */
export const EVIDENCE_TRUNCATE = 1800;

function renderEvidence(hit: EvidenceChunk, idx: number): string {
  // Delegates to the shared renderer so there is exactly one `[n] path/headings/tags/content`
  // shape in the tree. Callers now pre-trim via buildEvidence, so the `truncated` flag below is
  // recomputed here only for a caller that hands over raw chunks — the output is byte-identical
  // either way.
  const trimmed = trimToBoundary(hit.content, EVIDENCE_TRUNCATE);
  return renderEvidenceItem({
    citation: idx,
    path: hit.path,
    content: trimmed,
    headings: hit.headings,
    tags: hit.tags,
    truncated: trimmed.length < hit.content.length,
  });
}

function buildUserMessage(
  proposal: string,
  evidence: EvidenceChunk[],
  contradictions: ContradictionContext[],
): string {
  const parts: string[] = [
    `PROPOSAL:\n${proposal}\n`,
    `PAST EVIDENCE (${evidence.length} chunks):`,
  ];
  parts.push(
    evidence.length === 0
      ? "(none)"
      : evidence.map((h, i) => renderEvidence(h, i + 1)).join("\n\n"),
  );
  parts.push(`\n\nOPEN CONTRADICTIONS TOUCHING THIS EVIDENCE (${contradictions.length}):`);
  parts.push(
    contradictions.length === 0
      ? "(none)"
      : contradictions
          .map(
            (c) =>
              `id: ${c.id}\nsource: ${c.source_path}\nconflict: ${c.conflict_path}\nverdict: ${c.judge_verdict}\nrationale: ${c.judge_rationale}`,
          )
          .join("\n\n"),
  );
  return parts.join("\n");
}

/**
 * Red-team `proposal` against decision-bearing evidence + open contradictions via the gateway
 * `judge` role. The caller supplies the (already-retrieved + isDecisionChunk-filtered) evidence
 * — wiring that retrieval and registering the MCP tool are the integration step.
 */
export async function challengeProposal(
  roles: GatewayRoles,
  proposal: string,
  evidence: EvidenceChunk[],
  contradictions: ContradictionContext[],
  /** THE-934 fix round 1 (Blocking-3): egress.excludePaths, compiled. Undefined -> nothing
   *  excluded. `reflect`'s "challenge" mode and `knowledge_challenge` both retrieve through the
   *  ordinary (lexical-inclusive) recall path, so an excluded chunk — invisible to semantic_search
   *  by construction, but still a first-class lexical hit — reaches here as ordinary evidence
   *  unless dropped. Filtered HERE, once, so both callers share the fix rather than each
   *  reimplementing it. */
  excludeFilter?: EgressFilter,
): Promise<{ output: ChallengeOutput; model: string; excludedCount: number }> {
  const excluded = (p: string): boolean =>
    excludeFilter !== undefined && isExcludedPath(excludeFilter, p);
  const keptEvidence = evidence.filter((e) => !excluded(e.path));
  // A contradiction pair with EITHER side excluded is dropped wholesale — same rule
  // checkContradictions itself applies (plane/jobs/contradiction.ts).
  const keptContradictions = contradictions.filter(
    (c) => !excluded(c.source_path) && !excluded(c.conflict_path),
  );
  const excludedCount =
    evidence.length - keptEvidence.length + (contradictions.length - keptContradictions.length);
  const res = await roles.judge({
    ...prompt(
      CHALLENGE_SYSTEM_PROMPT,
      buildUserMessage(proposal, keptEvidence, keptContradictions),
    ),
    // THE-934: the egress guard's backstop check — every path here already cleared the filter.
    sourcePaths: [
      ...keptEvidence.map((e) => e.path),
      ...keptContradictions.flatMap((c) => [c.source_path, c.conflict_path]),
    ],
  });
  return { output: parseChallengeOutput(res.text), model: res.model, excludedCount };
}
