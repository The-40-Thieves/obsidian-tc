// The standard `search(query)` / `fetch(id)` tool pair. ChatGPT deep research and company knowledge
// only treat a connector as a knowledge source when it exposes tools with exactly these names, and
// they cite a result only when it carries a non-empty absolute `url`.
//
// Documented shapes (https://developers.openai.com/api/docs/mcp, read 2026-10-09):
//   search({query})  ->  {results: [{id, title, url}]}
//   fetch({id})      ->  {id, title, text, url, metadata?}
// each returned as `structuredContent` AND as the same value JSON-encoded in one text content item
// (mcp/tool-result.ts does both for every tool), with an object-rooted outputSchema declared.
// `search` adds a `text` snippet per result; the page does not list it, clients ignore extra keys.
//
// Neither tool is a new search or read path. `search` runs `search_vault` mode=auto (the text leg,
// then the semantic leg or their fusion, per `retrieval.searchAutoRoute`) and only reshapes its hits,
// so everything that decides what a caller may see (read ACL on the stored `acl_path` identity,
// Obsidian's Excluded files, the index) is that tool's code. Each hit is then re-judged on the
// canonical path (`enforcePathAcl`, the check read_note and fetch use) before it becomes a citation,
// so a search result is always something fetch will return. `fetch` is read_note's gate sequence.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { parseNoteLenient } from "../../vault/frontmatter";
import { noteExists, readNote, statNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { citationUrl, noteId, parseNoteId } from "./citation-url";
import type { M2Deps } from "./shared";

const SNIPPET_CHARS = 300;
const DEFAULT_RESULTS = 10;
const MAX_RESULTS = 50;
/** search_vault's own `limit` ceiling: ask for every hit, dedupe to notes here, then cut. */
const ALL_HITS = 1000;

const SearchInput = z
  .object({
    vault: VaultId,
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(DEFAULT_RESULTS),
  })
  .strict();

const SearchOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string(),
      text: z.string(),
    }),
  ),
});

/** The id is parsed AT the schema, so the vault it names is a real input field: dispatch's
 *  vault-binding guard (a bound token may act only on its own vault) and the per-vault ACL swap both
 *  read the parsed `vault`, and neither can see inside an opaque id string. */
const FetchInput = z
  .object({ id: z.string().min(1).max(1100) })
  .strict()
  .transform((input, ctx) => {
    const ref = parseNoteId(input.id);
    if ("error" in ref) {
      ctx.addIssue({ code: "custom", path: ["id"], message: ref.error });
      return z.NEVER;
    }
    return { id: input.id, vault: ref.vault, path: ref.path };
  });

const FetchOutput = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.object({
    vault: z.string(),
    path: z.string(),
    content_hash: z.string(),
    modified: z.string().optional(),
  }),
});

/** frontmatter `title`, else the first `# ` heading, else the file name. */
function titleOf(frontmatter: Record<string, unknown> | null, body: string, path: string): string {
  const fm = frontmatter?.title;
  if (typeof fm === "string" && fm.trim() !== "") return fm.trim();
  const heading = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  if (heading?.[1]) return heading[1];
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 3)}...` : flat;
}

interface Hit {
  path?: unknown;
  snippet?: unknown;
}

export function buildSearchFetchTools(deps: M2Deps, searchVault: ToolDefinition): ToolDefinition[] {
  return [
    defineTool({
      name: "search",
      domain: "search",
      description:
        "Search the vault for notes matching a natural-language query and return citable results: {results: [{id, title, url, text}]}, best first, one per note. Use this to find notes before answering from them; pass a result's id to fetch for the full note. url is an absolute link to the note (a published https url when the vault configures one, else an obsidian:// link). Hybrid text + semantic search; only notes the caller may read appear.",
      inputSchema: SearchInput,
      outputSchema: SearchOutput,
      requiredScopes: ["read:notes"],
      // search_vault embeds the query with the configured provider, which may be hosted.
      tags: ["external-network"],
      handler: async (input, ctx: CallerContext) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const routed = (await searchVault.handler(
          searchVault.inputSchema.parse({
            vault: v.id,
            query: input.query,
            mode: "auto",
            limit: ALL_HITS,
          }),
          ctx,
        )) as { items?: Hit[] };
        const results: z.infer<typeof SearchOutput>["results"] = [];
        const seen = new Set<string>();
        for (const hit of routed.items ?? []) {
          if (results.length >= input.limit) break;
          if (typeof hit.path !== "string" || seen.has(hit.path)) continue;
          seen.add(hit.path);
          try {
            // Fail closed: a hit the canonical-path check refuses, or that vanished since it was
            // indexed, is dropped, never cited.
            enforcePathAcl(ctx.acl, "read", hit.path, v.root, ctx.grantedScopes);
            const { raw } = readNote(resolveVaultPath(v.root, hit.path));
            const parsed = parseNoteLenient(raw, hit.path);
            const snippet = typeof hit.snippet === "string" ? hit.snippet : "";
            results.push({
              id: noteId(v.id, hit.path),
              title: titleOf(parsed.frontmatter, parsed.body, hit.path),
              url: citationUrl(v, hit.path),
              text: excerpt(snippet.trim() !== "" ? snippet : parsed.body),
            });
          } catch {
            // dropped
          }
        }
        return { results };
      },
    }),

    defineTool({
      name: "fetch",
      wholeNotes: true,
      domain: "notes",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Fetch one note by the id a search result returned and return {id, title, text, url, metadata}: the full note text (frontmatter included), an absolute citation url, and metadata {vault, path, content_hash, modified}. Refuses a note the caller may not read exactly as read_note does.",
      inputSchema: FetchInput,
      outputSchema: FetchOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx: CallerContext) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { vault: v.id, path: rel });
        const { raw, hash } = readNote(abs);
        const parsed = parseNoteLenient(raw, rel);
        const stat = statNote(abs);
        return {
          id: noteId(v.id, rel),
          title: titleOf(parsed.frontmatter, parsed.body, rel),
          text: raw,
          url: citationUrl(v, rel),
          metadata: {
            vault: v.id,
            path: rel,
            content_hash: hash,
            ...(stat ? { modified: stat.mtime } : {}),
          },
        };
      },
    }),
  ];
}
