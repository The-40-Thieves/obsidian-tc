// draft_wiki_page: step two of the wiki workflow (find_existing_page -> draft_wiki_page -> the
// calling LLM writes the prose -> commit_wiki_page). READ-ONLY. It never generates prose: it runs
// the dedupe check, builds the link map, reads the wiki folder's SCHEMA.md and hands back a
// CHANGESET SKELETON (the new page's path and frontmatter, plus the additive patches that keep the
// related pages linked to it) for the caller to fill in. The only model it can touch is the opt-in
// dedupe judge find_existing_page already has.
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { TOPIC_MATCH_MIN } from "../../../search/dedupe-band";
import { vaultExclusionFor } from "../../../search/index-exclusion";
import { readNote } from "../../../vault/notes-io";
import { resolveVaultPath } from "../../../vault/paths";
import { defineTool } from "../../m1/define";
import { ResponseFormatInput, resolveResponseFormat } from "../../response-format";
import { scanWarningsShape } from "../../scan-warnings";
import type { M7Deps } from "./deps";
import { FindExistingPageOutput, findExistingPage } from "./find-existing-page";
import type { RetrievalRuntime } from "./retrieval-runtime";
import { DEFAULT_LINK_HEADING } from "./wiki-changeset";
import { buildLinkMap, type LinkMap, pageTitleOf, proposedPagePath } from "./wiki-link-map";
import {
  checkFrontmatter,
  loadWikiSchema,
  WIKI_TYPE_KEY,
  type WikiPageType,
  type WikiSchemaLoad,
} from "./wiki-schema";

const LinkMapEntrySchema = z.object({
  path: z.string(),
  reasons: z.array(z.string()),
  score: z.number().optional(),
  in_wiki: z.boolean(),
});

const SchemaSection = z.object({
  /** Where SCHEMA.md is (or would be). */
  path: z.string().nullable(),
  found: z.boolean(),
  /** Why SCHEMA.md could not be read in full; the draft still works without it. */
  warnings: z.array(z.string()),
  types: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      required: z.array(z.string()),
      folder: z.string().optional(),
    }),
  ),
  /** Allowed property -> allowed values (null: any); null when the schema declares no vocabulary. */
  vocabulary: z.record(z.string(), z.array(z.string()).nullable()).nullable(),
});

export const DraftWikiPageOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  topic: z.string(),
  wiki: z.object({ folder: z.string().nullable(), schema: SchemaSection }),
  dedupe: FindExistingPageOutput.pick({
    verdict: true,
    total: true,
    candidates: true,
    next: true,
    semantic: true,
    judge: true,
    judged_by: true,
  }),
  suggestion: z.string(),
  /** Set when the topic already has a page: link to it or extend it instead of creating. */
  existing: z.object({ path: z.string(), content_hash: z.string() }).nullable(),
  requirements: z.object({
    /** The type the page will have (the one asked for, or the only one declared), if known. */
    type: z.string().nullable(),
    /** Frontmatter the type requires (and `type` itself when types are declared). */
    required: z.array(z.string()),
    /** Types to choose from when none was asked for. */
    choose_type: z.array(z.string()),
    problems: z.array(z.string()),
  }),
  link_map: z.object({
    link_to: z.array(LinkMapEntrySchema),
    link_from: z.array(LinkMapEntrySchema),
    already_linking: z.array(z.string()),
  }),
  /** The skeleton to fill in and pass to commit_wiki_page; null when a page already exists. */
  changeset: z
    .object({
      topic: z.string(),
      page: z.object({
        path: z.string(),
        mode: z.literal("create"),
        frontmatter: z.record(z.string(), z.unknown()),
        /** Empty: the calling LLM writes the prose. */
        body: z.string(),
      }),
      patches: z.array(
        z.object({
          path: z.string(),
          prev_hash: z.string(),
          operation: z.literal("link"),
          heading: z.string(),
        }),
      ),
      notes: z.array(z.string()),
    })
    .nullable(),
});

type Draft = z.infer<typeof DraftWikiPageOutput>;

function schemaSection(load: WikiSchemaLoad, hasFolder: boolean): Draft["wiki"]["schema"] {
  return {
    path: hasFolder ? load.path : null,
    found: load.found,
    warnings: load.warnings,
    types: load.schema?.types ?? [],
    vocabulary: load.schema?.vocabulary ?? null,
  };
}

/** The type the page will have, and what to tell the caller about the choice. */
function resolveType(
  asked: string | undefined,
  load: WikiSchemaLoad,
): { def: WikiPageType | undefined; name: string | null; problems: string[]; choose: string[] } {
  const types = load.schema?.types ?? [];
  const names = types.map((t) => t.name);
  if (asked) {
    const def = types.find((t) => t.name === asked);
    const problems =
      types.length > 0 && !def
        ? [`type "${asked}" is not declared in SCHEMA.md; choose one of: ${names.join(", ")}`]
        : [];
    return { def, name: asked, problems, choose: def ? [] : names };
  }
  if (types.length === 1)
    return { def: types[0], name: types[0]?.name ?? null, problems: [], choose: [] };
  return { def: undefined, name: null, problems: [], choose: names };
}

export function createDraftWikiPageTool(deps: M7Deps, retrieval: RetrievalRuntime): ToolDefinition {
  return defineTool({
    name: "draft_wiki_page",
    domain: "knowledge",
    description:
      "Plan a new wiki page WITHOUT writing anything: the step between find_existing_page and commit_wiki_page. Give a topic (and optionally a page `type` from the wiki folder's SCHEMA.md and `sources`, the notes or URLs the page draws on). Returns (1) the dedupe verdict from find_existing_page: if a page already exists you get it back with a suggestion to link to it or extend it instead of creating a duplicate, and no changeset; (2) the wiki folder's SCHEMA.md (page types, the frontmatter each requires, the allowed property vocabulary; a malformed file is a warning, never an error); (3) a link map: existing notes the new page should link TO (your sources, related pages) and notes that should link FROM it (notes that mention the topic without linking it, related wiki pages), and notes that already link it; (4) a CHANGESET SKELETON: the new page's path and frontmatter with the required fields empty, and a `link` patch (with the note's current prev_hash) for each note that should link to the new page. You write the page body (and any `text` for a patch); the server never writes prose. Pass the filled changeset to commit_wiki_page. Read-only: it never writes, respects the read ACL and Obsidian's Excluded files (an excluded note is never offered for patching), and with `judge` (default from the wikiJudge config) the dedupe check may send the topic and the opening text of up to 3 readable notes to the gateway judge model, exactly as find_existing_page does.",
    inputSchema: z
      .object({
        vault: VaultId,
        topic: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "The page topic or title you are about to write (a [[wikilink]] or a QID also works).",
          ),
        type: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Page type, one of the types in the wiki folder's SCHEMA.md. Sets the required frontmatter, the subfolder and the `type` property of the skeleton.",
          ),
        sources: z
          .array(z.string().min(1).max(1000))
          .max(50)
          .optional()
          .describe(
            "What the page draws on: note paths or [[wikilinks]] (they become link_to entries) or URLs. Copied into the skeleton's `sources` property.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(25)
          .default(8)
          .describe("Most entries in each link-map list, and most candidates shown."),
        min_similarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            `Lowest best-chunk cosine reported as a related note (default ${TOPIC_MATCH_MIN}, calibrated for BAAI/bge-m3).`,
          ),
        judge: z
          .boolean()
          .optional()
          .describe(
            "Let the wikiJudge LLM resolve an ambiguous dedupe verdict, as in find_existing_page. Default: the wikiJudge.enabled config.",
          ),
        ...ResponseFormatInput,
      })
      .strict(),
    outputSchema: DraftWikiPageOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "search", "external-network"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const scope = { root: v.root, acl: ctx.acl, grantedScopes: ctx.grantedScopes };
      const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
      const load = loadWikiSchema(scope, v.wikiFolder);
      const { output, ranked, scan } = await findExistingPage(deps, retrieval, ctx, v, {
        topic: input.topic,
        limit: input.limit,
        minSimilarity: input.min_similarity,
        judge: input.judge,
        concise,
      });
      const { warnings, warnings_omitted, vault: _v, topic: _t, ...dedupe } = output;
      const exclusion = vaultExclusionFor(deps.vaultRegistry, v.id);
      const exists = output.verdict === "exists" ? ranked[0] : undefined;
      const type = resolveType(input.type, load);
      const path = proposedPagePath(input.topic, {
        wikiFolder: v.wikiFolder,
        typeFolder: type.def?.folder,
      });
      const map: LinkMap = buildLinkMap({
        ranked,
        scan,
        sources: input.sources ?? [],
        wikiFolder: v.wikiFolder,
        selfPath: exists?.path ?? path,
        isExcluded: exclusion.isExcluded,
        limit: input.limit,
      });
      const hashOf = (rel: string): string => readNote(resolveVaultPath(v.root, rel)).hash;

      const requiredFields = type.def
        ? [...new Set([WIKI_TYPE_KEY, ...type.def.required])]
        : (load.schema?.types.length ?? 0) > 0
          ? [WIKI_TYPE_KEY]
          : [];
      const common = {
        ...(warnings ? { warnings } : {}),
        ...(warnings_omitted ? { warnings_omitted } : {}),
        vault: v.id,
        topic: input.topic,
        wiki: { folder: v.wikiFolder ?? null, schema: schemaSection(load, !!v.wikiFolder) },
        dedupe,
        requirements: {
          type: type.name,
          required: requiredFields,
          choose_type: type.choose,
          problems: type.problems,
        },
        link_map: map,
      };
      if (exists) {
        return {
          ...common,
          suggestion: output.next.note,
          existing: { path: exists.path, content_hash: hashOf(exists.path) },
          changeset: null,
        };
      }

      const sources = input.sources ?? [];
      const frontmatter: Record<string, unknown> = {};
      if (type.name) frontmatter[WIKI_TYPE_KEY] = type.name;
      for (const f of type.def?.required ?? []) if (!(f in frontmatter)) frontmatter[f] = "";
      if (sources.length > 0) frontmatter.sources = sources;
      else if (type.def?.required.includes("sources")) frontmatter.sources = [];
      const notes = [
        "Write `page.body` (and `text` on a patch if you want to say why a note is related), then call commit_wiki_page with this changeset.",
        "Drop any patch you do not want; each one only adds a link bullet to a note that should point at the new page.",
        ...(v.wikiFolder
          ? []
          : [
              "No wiki.folder is configured for this vault, so no SCHEMA.md applies and the page path is at the vault root; change `page.path` if it belongs elsewhere.",
            ]),
        ...(checkFrontmatter(load.schema, frontmatter, type.name ?? undefined).length > 0
          ? ["Fill in every empty frontmatter field before committing."]
          : []),
      ];
      return {
        ...common,
        suggestion:
          output.verdict === "ambiguous"
            ? `${output.next.note} If none of them covers the topic, fill in the changeset and call commit_wiki_page.`
            : `Nothing covers "${pageTitleOf(input.topic)}": fill in the changeset and call commit_wiki_page.`,
        existing: null,
        changeset: {
          topic: input.topic,
          page: { path, mode: "create" as const, frontmatter, body: "" },
          patches: map.link_from
            .filter((e) => e.in_wiki)
            .map((e) => ({
              path: e.path,
              prev_hash: hashOf(e.path),
              operation: "link" as const,
              heading: DEFAULT_LINK_HEADING,
            })),
          notes,
        },
      };
    },
  });
}
