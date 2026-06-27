// knowledge_challenge generative core — THE-233 W-WORKERS. Ports the red-team logic onto the
// gateway `judge` seam. The evidence-gathering (vault_search retrieval + isDecisionChunk
// filter) and the MCP tool registration are INTEGRATION-GATED — they need retrieval on main —
// so this module is the decoupled, testable generative core: prompt + call + parse, plus the
// pure isDecisionChunk classifier. knowledge_get_critical is NOT ported: it queries a KMS
// vendor-KB (knowledge_chunks: severity/mcp_name) data model the converged vault-centric tree
// does not have; it stays integration-gated (see MERGE-PROGRESS.md).
import { z } from "zod";
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

const challengeOutputSchema = z.object({
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

const EVIDENCE_TRUNCATE = 1800;

function renderEvidence(hit: EvidenceChunk, idx: number): string {
  const headings = (hit.headings ?? []).join(" > ");
  const tags = (hit.tags ?? []).join(", ");
  const content =
    hit.content.length > EVIDENCE_TRUNCATE
      ? `${hit.content.slice(0, EVIDENCE_TRUNCATE)}\n...[truncated]`
      : hit.content;
  return `[${idx}] path: ${hit.path}${headings ? `\nheadings: ${headings}` : ""}${tags ? `\ntags: ${tags}` : ""}\ncontent: ${content}`;
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
): Promise<{ output: ChallengeOutput; model: string }> {
  const res = await roles.judge(
    prompt(CHALLENGE_SYSTEM_PROMPT, buildUserMessage(proposal, evidence, contradictions)),
  );
  return { output: parseChallengeOutput(res.text), model: res.model };
}
