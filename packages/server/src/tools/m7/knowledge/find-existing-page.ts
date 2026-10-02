// find_existing_page: "does this vault already have a page on this topic?" — the check to run
// BEFORE write_note creates a new one, so a wiki links to a topic instead of restating it.
//
// READ-ONLY and advisory: it never writes, never blocks a write, and never throws on a missing
// embedding provider (the similarity half degrades, the identity half still answers). The verdict
// is `exists | ambiguous | new`:
//   exists     identity evidence (a name, alias, wikidata id or title) points at exactly one page;
//   ambiguous  several pages claim the topic, or the only evidence is soft (link text, similarity);
//   new        nothing found, creating a page is fine.
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
  kind: z.enum(["path", "name_variant", "alias", "wikidata", "title", "link_text", "semantic"]),
  detail: z.string().optional(),
  property: z.string().optional(),
  score: z.number().optional(),
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
});

function nextStep(verdict: PageVerdict, ranked: PageCandidate[]): z.infer<typeof NextSchema> {
  const top = ranked.slice(0, 3).map((c) => c.path);
  if (verdict === "exists") {
    const c = ranked[0] as PageCandidate;
    return {
      action: "link_to_existing",
      tool: "read_note",
      paths: [c.path],
      note: c.excluded
        ? `A page already covers this (left out of the search index by Excluded files, but it is a real note). Link to [[${c.path.replace(/\.md$/i, "")}]] instead of writing a new one.`
        : `A page already covers this. Read it, then link to [[${c.path.replace(/\.md$/i, "")}]] or extend it with patch_note instead of writing a new one.`,
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
    note: "Nothing in the vault covers this topic. Creating a new page is fine.",
  };
}

export function createFindExistingPageTool(
  deps: M7Deps,
  retrieval: RetrievalRuntime,
): ToolDefinition {
  return defineTool({
    name: "find_existing_page",
    domain: "knowledge",
    description:
      "Check whether a page on a topic ALREADY EXISTS before creating one (dedupe / page-exists check): run this before write_note when you are about to add a new wiki page, concept note or entity page, so you link to the existing page instead of writing a duplicate. Give a topic string (and optionally a folder to look in); get a verdict exists | ambiguous | new plus the candidate notes with the evidence for each: exact path or file name, an `aliases` frontmatter entry, a `wikidata:` property holding the same QID (pass 'Q42' or a wikidata URL), a title or H1, the text other notes (including property links) already link it under, and semantically near notes. Read-only and advisory: it never writes and never blocks. Respects the read ACL, and Obsidian's Excluded files: an excluded note still counts when its name or alias matches (it is a link target) but is never a similarity match. response_format=concise returns {path, strength, evidence kinds} per candidate, without evidence details or scores.",
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

      const ranked = [...candidates.values()].sort((a, b) => {
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
      const verdict = verdictOf(ranked);
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
        next: nextStep(verdict, ranked),
        semantic,
      };
    },
  });
}
