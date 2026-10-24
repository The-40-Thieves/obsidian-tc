// find_orphans (Domain 5, links): notes nothing else links to. Split out of links-tools.ts, which
// sat at the 700-line ceiling; its shared deps come straight from their own modules, so this file
// and links-tools.ts never import each other.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { DEFAULT_SCAN_LIMIT, nextOffsetCursor, offsetOf } from "../../util/paginate";
import { drainYielding, type ScanSteps } from "../../util/scan-steps";
import { statNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { ScanWarnings, scanWarningsShape } from "../scan-warnings";
import { scanOrphansSteps } from "../wiki-scan";
import { defineTool } from "./define";
import type { M1Deps } from "./shared";

/** group_by=folder: one entry per top-level folder ("/" for notes at the vault root). `oldest` and
 *  `newest` are the min and max filesystem mtime (ISO 8601) of its orphans; null only when no note
 *  in the group could be stat'd (deleted since the scan). */
const FolderGroups = z.array(
  z.object({
    folder: z.string(),
    count: z.number().int(),
    oldest: z.string().nullable(),
    newest: z.string().nullable(),
  }),
);

type FolderGroup = z.infer<typeof FolderGroups>[number];

/** Orphans grouped by top-level folder, biggest group first. Computed over the whole result, not the
 *  page. ISO 8601 UTC strings compare in time order, so min and max are plain string comparisons.
 *  A step generator (one stat per step) so drainYielding hands the event loop back on large results. */
export function* groupByFolderSteps(root: string, orphans: string[]): ScanSteps<FolderGroup[]> {
  const groups = new Map<string, Omit<FolderGroup, "folder">>();
  for (const p of orphans) {
    yield;
    const slash = p.indexOf("/");
    const folder = slash < 0 ? "/" : p.slice(0, slash);
    const mtime = statNote(resolveVaultPath(root, p))?.mtime ?? null;
    const g = groups.get(folder) ?? { count: 0, oldest: null, newest: null };
    g.count += 1;
    if (mtime !== null) {
      if (g.oldest === null || mtime < g.oldest) g.oldest = mtime;
      if (g.newest === null || mtime > g.newest) g.newest = mtime;
    }
    groups.set(folder, g);
  }
  return [...groups]
    .map(([folder, g]) => ({ folder, ...g }))
    .sort((a, b) => b.count - a.count || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

const FindOrphansOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  total: z.number().int(),
  truncated: z.boolean(),
  next_cursor: z.string().nullable(),
  orphans: z.array(z.string()),
  groups: FolderGroups.optional(),
});

export function buildOrphansTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "find_orphans",
      domain: "links",
      description:
        "Find notes that nothing else links to (optionally also requiring no outgoing links); a link in a property counts. A note whose frontmatter is not valid YAML does not fail the scan: its body is still read and it is named in `warnings`. group_by=folder adds `groups`: the orphan count and oldest/newest mtime per top-level folder, over the whole result.",
      inputSchema: z
        .object({
          vault: VaultId,
          folder: VaultPath.optional(),
          limit: z.number().int().positive().max(5000).default(DEFAULT_SCAN_LIMIT),
          cursor: z.string().optional(),
          require_no_outgoing: z.boolean().default(false),
          group_by: z.enum(["folder"]).optional(),
        })
        .strict(),
      outputSchema: FindOrphansOutput,
      requiredScopes: ["read:notes"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const warnings = new ScanWarnings();
        const orphans = await drainYielding(
          scanOrphansSteps(
            {
              root: v.root,
              acl: ctx.acl,
              grantedScopes: ctx.grantedScopes,
              wikiFolder: v.wikiFolder,
              wikiFolders: v.wikiFolders,
              rawFolders: v.rawFolders,
            },
            warnings,
            { folder: sub, requireNoOutgoing: input.require_no_outgoing },
          ),
          ctx.signal,
        );
        const groups =
          input.group_by === "folder"
            ? await drainYielding(groupByFolderSteps(v.root, orphans), ctx.signal)
            : undefined;
        const skip = offsetOf(input.cursor);
        const page = orphans.slice(skip, skip + input.limit);
        const truncated = orphans.length > skip + input.limit;
        return {
          ...warnings.out(),
          vault: v.id,
          total: orphans.length,
          truncated,
          next_cursor: nextOffsetCursor(skip, page.length, truncated),
          orphans: page,
          ...(groups !== undefined ? { groups } : {}),
        };
      },
    }),
  ];
}
