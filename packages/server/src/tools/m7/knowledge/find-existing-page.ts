// find_existing_page: "does this vault already have a page on this topic?" — the check to run
// BEFORE write_note creates a new one, so a wiki links to a topic instead of restating it.
//
// READ-ONLY and advisory: it never writes, never blocks a write, and never throws on a missing
// embedding provider (the similarity half degrades, the identity half still answers). The verdict
// is `exists | ambiguous | new`:
//   exists     identity evidence (a name, alias, wikidata id or title) points at exactly one page;
//   ambiguous  several pages claim the topic, or the only evidence is soft (link text, similarity);
//   new        nothing found, creating a page is fine.
// An optional LLM judge (wiki-judge.ts) resolves AMBIGUOUS candidates that rest on soft evidence
// only: exactly one `same_topic` ruling makes the verdict `exists`, all candidates ruled `different`
// make it `new`, anything else (overlapping, several same_topic, a failure, a spent cap) stays
// `ambiguous`. It never runs when identity evidence is present and never overrides it.
// Identity evidence is read from the files (wiki-evidence.ts), so a note Obsidian's Excluded files
// hides from the index still counts as "exists". Similarity evidence comes from the index, so an
// excluded note is never a similarity candidate. Both halves are ACL-filtered: a note the caller
// cannot read is indistinguishable from a missing one.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { TOPIC_MATCH_MIN } from "../../../search/dedupe-band";
import { vaultExclusionFor } from "../../../search/index-exclusion";
import { semanticSearch } from "../../../search/semantic";
import { readableRel } from "../../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../../vault/paths";
import { defineTool } from "../../m1/define";
import { ResponseFormatInput, resolveResponseFormat } from "../../response-format";
import { scanWarningsShape } from "../../scan-warnings";
import type { M7Deps } from "./deps";
import type { RetrievalRuntime } from "./retrieval-runtime";
import {
  collectIdentityEvidence,
  type Evidence,
  type PageCandidate,
  STRONG_KINDS,
} from "./wiki-evidence";
import {
  createWikiJudge,
  DEFAULT_WIKI_JUDGE_SETTINGS,
  type JudgeFailure,
  loadSendable,
  type SendableNote,
  type SendScope,
  type WikiJudge,
  type WikiJudgeVerdict,
} from "./wiki-judge";

export type PageVerdict = "exists" | "ambiguous" | "new";

/** The verdict rule, on its own so it is testable without a vault. `exists` needs identity evidence
 *  naming ONE page: an unambiguous path match wins over aliases elsewhere (Obsidian would resolve
 *  `[[topic]]` to it), otherwise exactly one strong candidate. Soft evidence alone is `ambiguous`. */
export function verdictOf(candidates: readonly PageCandidate[]): PageVerdict {
  const hasKind = (c: PageCandidate, k: string): boolean => c.evidence.some((e) => e.kind === k);
  const strong = candidates.filter((c) => c.evidence.some((e) => STRONG_KINDS.has(e.kind)));
  const byPath = candidates.filter((c) => hasKind(c, "path"));
  if (byPath.length === 1) return "exists";
  if (byPath.length > 1) return "ambiguous";
  if (strong.length === 1) return "exists";
  if (strong.length > 1) return "ambiguous";
  return candidates.length > 0 ? "ambiguous" : "new";
}

const EvidenceSchema = z.object({
  kind: z.enum([
    "path",
    "name_variant",
    "alias",
    "wikidata",
    "title",
    "link_text",
    "semantic",
    "judged_by",
  ]),
  detail: z.string().optional(),
  property: z.string().optional(),
  score: z.number().optional(),
  model: z.string().optional(),
  verdict: z.string().optional(),
});

const CandidateSchema = z.object({
  path: z.string(),
  strength: z.enum(["strong", "soft"]),
  // detailed: evidence objects; concise: just the kinds.
  evidence: z.array(z.union([EvidenceSchema, z.string()])),
  excluded: z.boolean().optional(),
});

const NextSchema = z.object({
  action: z.enum(["link_to_existing", "review_candidates", "create_new"]),
  tool: z.string(),
  paths: z.array(z.string()),
  note: z.string(),
});

const JudgeVerdictSchema = z.enum(["same_topic", "overlapping", "different"]);

// What the judge did on this call. Present when it ran, or when the caller asked (judge=true) and it
// could not.
const JudgeSectionSchema = z.object({
  ran: z.boolean(),
  /** Why it did not run (no gateway, nothing ambiguous, identity evidence present). */
  reason: z.string().optional(),
  /** Resolved model that ruled, never the gateway alias. */
  model: z.string().optional(),
  /** Gateway calls made now / verdicts served from the cache. */
  calls: z.number().int(),
  cached: z.number().int(),
  results: z.array(
    z.object({
      path: z.string(),
      verdict: JudgeVerdictSchema,
      rationale: z.string(),
      cached: z.boolean(),
    }),
  ),
  /** Candidates that were not judged, and why (excluded, daily cap, timeout, unusable reply...). */
  unjudged: z.array(z.object({ path: z.string(), reason: z.string() })),
});

export const FindExistingPageOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  topic: z.string(),
  verdict: z.enum(["exists", "ambiguous", "new"]),
  total: z.number().int(),
  candidates: z.array(CandidateSchema),
  next: NextSchema,
  // Whether the similarity half ran; `reason` says why not (no embedding provider, no vectors).
  semantic: z.object({ checked: z.boolean(), min: z.number(), reason: z.string().optional() }),
  judge: JudgeSectionSchema.optional(),
  // Set only when the judge MOVED the verdict (ambiguous -> exists / new): who ruled, and why.
  judged_by: z
    .object({
      model: z.string(),
      verdict: z.enum(["same_topic", "different"]),
      rationale: z.string(),
      paths: z.array(z.string()),
    })
    .optional(),
});

type JudgeSection = z.infer<typeof JudgeSectionSchema>;

function nextStep(
  verdict: PageVerdict,
  ranked: PageCandidate[],
  judgedBy?: string,
): z.infer<typeof NextSchema> {
  const top = ranked.slice(0, 3).map((c) => c.path);
  if (verdict === "exists") {
    const c = ranked[0] as PageCandidate;
    return {
      action: "link_to_existing",
      tool: "read_note",
      paths: [c.path],
      note: c.excluded
        ? `A page already covers this (left out of the search index by Excluded files, but it is a real note). Link to [[${c.path.replace(/\.md$/i, "")}]] instead of writing a new one.`
        : `A page already covers this${judgedBy ? ` (a judge, ${judgedBy}, ruled the same topic; check by reading it)` : ""}. Read it, then link to [[${c.path.replace(/\.md$/i, "")}]] or extend it with patch_note instead of writing a new one.`,
    };
  }
  if (verdict === "ambiguous")
    return {
      action: "review_candidates",
      tool: "read_notes",
      paths: top,
      note: "Possible matches, none certain. Read them: if one covers the topic, link to it or extend it; otherwise creating a new page is fine.",
    };
  return {
    action: "create_new",
    tool: "write_note",
    paths: [],
    note: judgedBy
      ? `No candidate covers this topic (a judge, ${judgedBy}, ruled each one a different topic). Creating a new page is fine.`
      : "Nothing in the vault covers this topic. Creating a new page is fine.",
  };
}

const hasStrong = (c: PageCandidate): boolean => c.evidence.some((e) => STRONG_KINDS.has(e.kind));

interface JudgeResolution {
  section: JudgeSection;
  verdict: PageVerdict;
  ranked: PageCandidate[];
  judgedBy?: z.infer<typeof FindExistingPageOutput>["judged_by"];
}

/**
 * Let the judge resolve an AMBIGUOUS verdict that rests on soft evidence only. The top candidates
 * (at most `maxCallsPerRequest`, skipping any that may not be sent) are read and judged in parallel;
 * every failure is a note in `unjudged`, never an error. Candidate evidence gains a `judged_by`
 * entry; `ranked` is reordered so the confirmed page leads.
 */
async function resolveWithJudge(
  judge: WikiJudge,
  scope: SendScope,
  excludeFilter: M7Deps["excludeFilter"],
  topic: string,
  ranked: PageCandidate[],
): Promise<JudgeResolution> {
  const section: JudgeSection = { ran: true, calls: 0, cached: 0, results: [], unjudged: [] };
  const budget = judge.newBudget();
  const targets: { c: PageCandidate; note: SendableNote }[] = [];
  for (const c of ranked) {
    if (targets.length >= judge.settings.maxCallsPerRequest) break;
    const r = loadSendable(scope, excludeFilter, c.path);
    if ("note" in r) targets.push({ c, note: r.note });
    else section.unjudged.push({ path: c.path, reason: r.refused });
  }
  const outcomes = await Promise.all(targets.map((t) => judge.judgeTopic(topic, t.note, budget)));
  const ruled: { c: PageCandidate; verdict: WikiJudgeVerdict; rationale: string; model: string }[] =
    [];
  outcomes.forEach((o, i) => {
    const c = (targets[i] as (typeof targets)[number]).c;
    if (!o.ok) {
      section.unjudged.push({ path: c.path, reason: o.reason satisfies JudgeFailure });
      return;
    }
    if (o.cached) section.cached++;
    else section.calls++;
    section.model ??= o.model;
    section.results.push({
      path: c.path,
      verdict: o.verdict,
      rationale: o.rationale,
      cached: o.cached,
    });
    c.evidence.push({ kind: "judged_by", model: o.model, verdict: o.verdict, detail: o.rationale });
    ruled.push({ c, verdict: o.verdict, rationale: o.rationale, model: o.model });
  });

  const same = ruled.filter((r) => r.verdict === "same_topic");
  if (same.length === 1) {
    const hit = same[0] as (typeof ruled)[number];
    return {
      section,
      verdict: "exists",
      ranked: [hit.c, ...ranked.filter((c) => c !== hit.c)],
      judgedBy: {
        model: hit.model,
        verdict: "same_topic",
        rationale: hit.rationale,
        paths: [hit.c.path],
      },
    };
  }
  // `new` needs EVERY candidate ruled different: one unjudged or unsure candidate may be the page.
  if (ruled.length === ranked.length && ruled.every((r) => r.verdict === "different")) {
    const first = ruled[0] as (typeof ruled)[number];
    return {
      section,
      verdict: "new",
      ranked,
      judgedBy: {
        model: first.model,
        verdict: "different",
        rationale: first.rationale,
        paths: ruled.map((r) => r.c.path),
      },
    };
  }
  return { section, verdict: "ambiguous", ranked };
}

export function createFindExistingPageTool(
  deps: M7Deps,
  retrieval: RetrievalRuntime,
): ToolDefinition {
  return defineTool({
    name: "find_existing_page",
    domain: "knowledge",
    description:
      "Check whether a page on a topic ALREADY EXISTS before creating one (dedupe / page-exists check): run this before write_note when you are about to add a new wiki page, concept note or entity page, so you link to the existing page instead of writing a duplicate. Give a topic string (and optionally a folder to look in); get a verdict exists | ambiguous | new plus the candidate notes with the evidence for each: exact path or file name, an `aliases` frontmatter entry, a `wikidata:` property holding the same QID (pass 'Q42' or a wikidata URL), a title or H1, the text other notes (including property links) already link it under, and semantically near notes. Read-only and advisory: it never writes and never blocks. Respects the read ACL, and Obsidian's Excluded files: an excluded note still counts when its name or alias matches (it is a link target) but is never a similarity match. Ambiguous candidates that rest on similarity or link text alone can be resolved by an LLM judge (`judge`, default from config): exactly one same-topic ruling makes the verdict exists, all candidates ruled different makes it new, anything else (or any failure) stays ambiguous; a name, alias or wikidata match is never overridden or sent to it. response_format=concise returns {path, strength, evidence kinds} per candidate, without evidence details or scores.",
    inputSchema: z
      .object({
        vault: VaultId,
        topic: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "The page topic or title you are about to write, a [[wikilink]], or a wikidata QID (Q42).",
          ),
        folder: VaultPath.optional().describe(
          "Only report candidates inside this folder. Omit to check the whole vault, which is what avoids a duplicate elsewhere.",
        ),
        limit: z.number().int().positive().max(25).default(8),
        min_similarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            `Lowest best-chunk cosine reported as a similar note (default ${TOPIC_MATCH_MIN}, calibrated for BAAI/bge-m3; recall at that floor is low, lower it to see weaker candidates).`,
          ),
        judge: z
          .boolean()
          .optional()
          .describe(
            "Let an LLM judge resolve AMBIGUOUS candidates that rest on soft evidence (similarity, link text): same topic -> exists, all different -> new, anything else stays ambiguous. Never overrides a name, alias or wikidata match and never blocks. Sends the topic and the opening text of at most 3 top candidates to the judge model (the gateway's, or TypeSafe Jev), only for notes you may read outside egress.excludePaths and Obsidian's Excluded files. Default: the wikiJudge.enabled config (off); true needs a configured judge.",
          ),
        ...ResponseFormatInput,
      })
      .strict(),
    outputSchema: FindExistingPageOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "search", "external-network"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const folder = input.folder ? normalizeVaultPath(input.folder) : undefined;
      const exclusion = vaultExclusionFor(deps.vaultRegistry, v.id);
      const identity = collectIdentityEvidence(
        { root: v.root, acl: ctx.acl, grantedScopes: ctx.grantedScopes },
        input.topic,
        { folder, isExcluded: exclusion.isExcluded },
      );
      const candidates = identity.candidates;
      const min = input.min_similarity ?? TOPIC_MATCH_MIN;
      const semantic: { checked: boolean; min: number; reason?: string } = { checked: false, min };
      const prefix = folder ? `${folder.replace(/\/+$/, "")}/` : "";
      try {
        const queryVec = await retrieval.embedQuery(input.topic);
        const hits = semanticSearch(ctx.db, v.id, queryVec, {
          k: 40,
          minScore: min,
          // Similarity evidence is search-derived: only notes that are readable, inside the folder
          // and actually in the index (not hidden by Excluded files) may be candidates.
          isReadable: (rel) =>
            readableRel(ctx.acl, rel, ctx.grantedScopes) &&
            (prefix === "" || rel.startsWith(prefix)) &&
            !exclusion.isExcluded(rel),
          model: deps.embeddingProvider.id,
        });
        semantic.checked = true;
        if (hits.length === 0) semantic.reason = "no indexed note scored above min_similarity";
        const best = new Map<string, number>();
        for (const h of hits) best.set(h.path, Math.max(best.get(h.path) ?? 0, h.score));
        for (const [path, score] of best) {
          const c = candidates.get(path) ?? { path, evidence: [], excluded: false };
          c.evidence.push({ kind: "semantic", score: Number(score.toFixed(3)) });
          candidates.set(path, c);
        }
      } catch (e) {
        // Advisory tool: an embedding outage must not turn "does a page exist?" into an error.
        semantic.reason = `similarity not checked: ${e instanceof Error ? e.message : String(e)}`;
      }

      let ranked = [...candidates.values()].sort((a, b) => {
        const sa = a.evidence.some((e) => STRONG_KINDS.has(e.kind)) ? 1 : 0;
        const sb = b.evidence.some((e) => STRONG_KINDS.has(e.kind)) ? 1 : 0;
        const top = (c: PageCandidate): number =>
          Math.max(0, ...c.evidence.map((e) => (e.kind === "semantic" ? (e.score ?? 0) : 0)));
        return (
          sb - sa ||
          b.evidence.length - a.evidence.length ||
          top(b) - top(a) ||
          a.path.localeCompare(b.path)
        );
      });
      let verdict = verdictOf(ranked);

      // The judge: AMBIGUOUS verdicts on soft evidence only. Exact evidence is final.
      const settings = deps.wikiJudge ?? DEFAULT_WIKI_JUDGE_SETTINGS;
      const wiki = createWikiJudge({
        roles: deps.roles,
        backend: deps.wikiJudgeBackend,
        db: ctx.db,
        settings,
      });
      let judgeSection: JudgeSection | undefined;
      let judgedBy: JudgeResolution["judgedBy"];
      const refuse = (reason: string): JudgeSection => ({
        ran: false,
        reason,
        calls: 0,
        cached: 0,
        results: [],
        unjudged: [],
      });
      if (input.judge ?? (settings.enabled && wiki.available)) {
        if (!wiki.available)
          judgeSection = refuse(
            "no judge is available: it needs a configured judge (a gateway, or wikiJudge.provider typesafe) and wikiJudge.maxCallsPerDay above 0",
          );
        else if (ranked.some(hasStrong))
          judgeSection = refuse(
            "identity evidence (name, alias, wikidata) is never overridden by the judge",
          );
        else if (verdict !== "ambiguous") judgeSection = refuse("nothing ambiguous to resolve");
        else {
          const res = await resolveWithJudge(
            wiki,
            { root: v.root, acl: ctx.acl, grantedScopes: ctx.grantedScopes, exclusion },
            deps.excludeFilter,
            input.topic,
            ranked,
          );
          judgeSection = res.section;
          judgedBy = res.judgedBy;
          verdict = res.verdict;
          ranked = res.ranked;
        }
        // A default-on judge with nothing to do stays out of the answer; an explicit ask is answered.
        if (input.judge !== true && !judgeSection.ran) judgeSection = undefined;
      }
      const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
      const shown = ranked.slice(0, input.limit);
      return {
        ...identity.warnings.out(),
        vault: v.id,
        topic: input.topic,
        verdict,
        total: ranked.length,
        candidates: shown.map((c) => ({
          path: c.path,
          strength: c.evidence.some((e) => STRONG_KINDS.has(e.kind))
            ? ("strong" as const)
            : ("soft" as const),
          evidence: concise
            ? [...new Set(c.evidence.map((e) => e.kind))]
            : (c.evidence as Evidence[]),
          ...(c.excluded ? { excluded: true } : {}),
        })),
        next: nextStep(verdict, ranked, judgedBy?.model),
        semantic,
        ...(judgeSection ? { judge: judgeSection } : {}),
        ...(judgedBy ? { judged_by: judgedBy } : {}),
      };
    },
  });
}
