// knowledge_challenge generative core — THE-233 W-WORKERS. Ports the red-team logic onto the
// gateway `judge` seam. The evidence-gathering (vault_search retrieval + isDecisionChunk
// filter) and the MCP tool registration are INTEGRATION-GATED — they need retrieval on main —
// so this module is the decoupled, testable generative core: prompt + call + parse, plus the
// pure isDecisionChunk classifier. knowledge_get_critical is NOT ported: it queries a KMS
// vendor-KB (knowledge_chunks: severity/mcp_name) data model the converged vault-centric tree
// does not have; it stays integration-gated (THE-233 integration follow-up).
import { z } from "zod";
import { renderEvidenceItem, renderWikilinkCitations, trimToBoundary } from "../search/evidence";
import { extractLinks, normalizeLinkTarget } from "../vault/links";
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
  chunkId?: string | undefined;
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

/** What the citation check found in the judge's output. */
export interface CitationCheck {
  /** Paths the judge cited that were not among the evidence it was shown. */
  unresolved: string[];
  /** Items dropped because none of their cited paths was shown. */
  droppedItems: number;
}

/** The link target a cited string names: a lone `[[wikilink]]` unwraps to its target, anything else
 *  is the string itself, with `./` and backslashes normalised. */
function citedTarget(value: string): string {
  const links = extractLinks(value);
  const target = links.length === 1 && links[0]?.raw === value ? links[0].target : value;
  return normalizeLinkTarget(target).trim();
}

interface NormalizedCitation {
  canonicalPath?: string;
  scrubReliable: boolean;
}

/** Normalize only the citation syntaxes the challenge prompt advertises. The result is still a
 *  vault-relative path; it is never resolved by basename or case-folded. */
function normalizeCitation(
  raw: string,
  numberedEvidence: ReadonlyArray<{ citation: number; path: string }>,
): NormalizedCitation {
  // A numbered citation names its shown item directly. Rendering it as `[[...]]` first would split
  // a path holding `#`, `|` or `]` into a different link target.
  const numbered = /^\[(\d+)\]$/.exec(raw.trim());
  if (numbered) {
    const path = numberedEvidence.find((e) => e.citation === Number(numbered[1]))?.path;
    return path === undefined
      ? { scrubReliable: false }
      : { canonicalPath: path, scrubReliable: true };
  }
  const rendered = renderWikilinkCitations(raw.trim(), numberedEvidence);
  if (rendered.unresolved.length > 0) return { scrubReliable: false };
  const target = citedTarget(rendered.text.trim());
  if (target === "") return { scrubReliable: false };
  return {
    canonicalPath: /\.md$/i.test(target) ? target : `${target}.md`,
    scrubReliable: true,
  };
}

/** A bare name shorter than this is too common a word to scrub: a basename `a` would otherwise wipe
 *  every rationale containing the letter. Its full-path and wikilink forms still match. */
const MIN_BARE_SPELLING = 4;

/** Spellings under which a stripped canonical path may reappear in free text: the path and its
 *  basename, each as written, dot-relative, wikilinked, and slugged (spaces to `-` or `_`, or
 *  percent-encoded). Matching is conservative: a false hit yields neutral text, while a miss can
 *  disclose an unseen path. */
function citationSpellings(canonicalPath: string, raw: string): string[] {
  const noExt = canonicalPath.replace(/\.md$/i, "");
  const base = noExt.slice(noExt.lastIndexOf("/") + 1);
  const spellings = [raw.trim(), canonicalPath, noExt, `${base}.md`, base].flatMap((name) =>
    [name, name.replace(/ /g, "-"), name.replace(/ /g, "_"), encodeURI(name)].flatMap((s) => [
      s,
      `./${s}`,
      `[[${s}]]`,
    ]),
  );
  return [...new Set(spellings.map((s) => s.toLowerCase()))].filter(
    (s) => s !== "" && (!isBareName(s) || s.length >= MIN_BARE_SPELLING),
  );
}

/** A name with no folder, extension or bracket: the only spelling a short word could collide with. */
const isBareName = (s: string): boolean => !/[./[]/.test(s);

/** The path-like pieces a cited string may hold. A malformed citation can pack several paths into one
 *  string (`a.md, b.md`, `a.md b.md`); each is scrubbed on its own as well as the whole string. */
function citedPieces(raw: string): string[] {
  const parts = raw.split(/[,;\n]+/);
  const mdPaths = raw.match(/[^\s,;]+\.md\b/gi) ?? [];
  return [...new Set([...parts, ...mdPaths].map((p) => p.trim()))].filter((p) => p !== "");
}

const isNameChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** True when `spelling` occurs in `lower` at a path-token boundary, not flanked by a letter, digit or
 *  underscore: `a.md` matches in `Notes/a.md` but not in `data.md`. */
function containsSpelling(lower: string, spelling: string): boolean {
  for (let at = lower.indexOf(spelling); at !== -1; at = lower.indexOf(spelling, at + 1)) {
    if (!isNameChar(lower[at - 1]) && !isNameChar(lower[at + spelling.length])) return true;
  }
  return false;
}

const STRIPPED_SUMMARY =
  "Some cited evidence was unavailable; retained findings use supported evidence only.";
const STRIPPED_RATIONALE = "Rationale omitted: it named evidence that was unavailable.";

/** Keeps only evidence the judge was shown. An item is grounded when at least one of its paths was
 *  shown; its unseen paths are stripped and reported, and an item with no shown path is dropped. A
 *  category left with no items is dropped too. A non-"proceed" verdict left with no supported
 *  category is downgraded to "reconsider" with a neutral summary. The summary and each retained
 *  item's rationale are replaced when they name stripped evidence, in any spelling. */
export function checkCitations(
  output: ChallengeOutput,
  shown: ReadonlySet<string>,
  numberedEvidence: ReadonlyArray<{ citation: number; path: string }> = [],
): { output: ChallengeOutput; citations: CitationCheck } {
  const unresolved = new Set<string>();
  const resolveCitation = (raw: string): string | undefined => {
    // An exact shown path wins before any normalising: a real note named `[2024] Q3 review.md` must
    // not be read as numbered citation `[2024]`.
    const exact = raw.trim();
    if (shown.has(exact)) return exact;
    const normalized = normalizeCitation(raw, numberedEvidence);
    return normalized.canonicalPath !== undefined && shown.has(normalized.canonicalPath)
      ? normalized.canonicalPath
      : undefined;
  };
  let droppedItems = 0;
  const grounded = output.categories.flatMap((cat) => {
    const items = cat.items.flatMap((item) => {
      const paths = item.evidence_paths.flatMap((path) => {
        const resolved = resolveCitation(path);
        if (resolved === undefined) {
          unresolved.add(path);
          return [];
        }
        return [resolved];
      });
      if (paths.length === 0) {
        droppedItems++;
        return [];
      }
      return [{ ...item, evidence_paths: [...new Set(paths)] }];
    });
    return items.length > 0 ? [{ ...cat, items }] : [];
  });
  const scrubTargets = [...unresolved].flatMap((raw) => [
    { raw, normalized: normalizeCitation(raw, numberedEvidence) },
    ...citedPieces(raw).map((piece) => ({
      raw: piece,
      normalized: normalizeCitation(piece, numberedEvidence),
    })),
  ]);
  const unreliableScrub = scrubTargets.some(({ normalized }) => !normalized.scrubReliable);
  const strippedSpellings = scrubTargets.flatMap(({ raw, normalized }) =>
    normalized.canonicalPath === undefined ? [] : citationSpellings(normalized.canonicalPath, raw),
  );
  const namesStripped = (text: string): boolean => {
    if (unreliableScrub) return true;
    const lower = text.toLowerCase();
    return strippedSpellings.some((s) => containsSpelling(lower, s));
  };
  const categories = grounded.map((cat) => ({
    ...cat,
    items: cat.items.map((item) =>
      namesStripped(item.why_it_matters) ? { ...item, why_it_matters: STRIPPED_RATIONALE } : item,
    ),
  }));
  // A "proceed" asserts no objection, so it needs no citation. Any other verdict is an objection
  // and survives only while a supported citation backs it, whether the judge's citations were
  // stripped here or it never cited anything.
  const unsupportedObjection = output.verdict !== "proceed" && categories.length === 0;
  return {
    output: unsupportedObjection
      ? {
          verdict: "reconsider",
          summary: "Insufficient supported evidence to retain the original verdict.",
          categories,
        }
      : {
          ...output,
          summary: namesStripped(output.summary) ? STRIPPED_SUMMARY : output.summary,
          categories,
        },
    citations: { unresolved: [...unresolved], droppedItems },
  };
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
export async function challengeProposal<E extends EvidenceChunk>(
  roles: GatewayRoles,
  proposal: string,
  evidence: E[],
  contradictions: ContradictionContext[],
  /** THE-934 fix round 1 (Blocking-3): egress.excludePaths, compiled. Undefined -> nothing
   *  excluded. `reflect`'s "challenge" mode and `knowledge_challenge` both retrieve through the
   *  ordinary (lexical-inclusive) recall path, so an excluded chunk — invisible to semantic_search
   *  by construction, but still a first-class lexical hit — reaches here as ordinary evidence
   *  unless dropped. Filtered HERE, once, so both callers share the fix rather than each
   *  reimplementing it. */
  excludeFilter?: EgressFilter,
): Promise<{
  output: ChallengeOutput;
  model: string;
  excludedCount: number;
  citations: CitationCheck;
  keptEvidence: E[];
  keptContradictions: ContradictionContext[];
  /** False when egress exclusion left no evidence: the judge was not called and `output` is a
   *  placeholder the caller must not surface. */
  judged: boolean;
}> {
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
  // The callers refuse an empty evidence set before the filter runs; this is the same refusal for
  // the set the filter leaves, so the judge is never asked to red-team against nothing.
  if (keptEvidence.length === 0) {
    return {
      output: {
        verdict: "reconsider",
        summary: "No evidence to challenge against.",
        categories: [],
      },
      model: "",
      excludedCount,
      citations: { unresolved: [], droppedItems: 0 },
      keptEvidence,
      keptContradictions,
      judged: false,
    };
  }
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
  // A citation is grounded only if the judge was shown that path. Checked here, once, so every
  // caller that renders the verdict gets the same grounding.
  const checked = checkCitations(
    parseChallengeOutput(res.text),
    new Set([
      ...keptEvidence.map((e) => e.path),
      ...keptContradictions.flatMap((c) => [c.source_path, c.conflict_path]),
    ]),
    keptEvidence.map((e, i) => ({ citation: i + 1, path: e.path })),
  );
  return {
    output: checked.output,
    model: res.model,
    excludedCount,
    citations: checked.citations,
    keptEvidence,
    keptContradictions,
    judged: true,
  };
}
