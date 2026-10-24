// find_orphans (Domain 5, links): notes nothing else links to. Split out of links-tools.ts, which
// sat at the 700-line ceiling; its shared deps come straight from their own modules, so this file
// and links-tools.ts never import each other.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { DEFAULT_SCAN_LIMIT, nextOffsetCursor, offsetOf } from "../../util/paginate";
import { drainYielding } from "../../util/scan-steps";
import { normalizeVaultPath } from "../../vault/paths";
import { ScanWarnings, scanWarningsShape } from "../scan-warnings";
import { scanOrphansSteps } from "../wiki-scan";
import { defineTool } from "./define";
import type { M1Deps } from "./shared";

const FindOrphansOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  total: z.number().int(),
  truncated: z.boolean(),
  next_cursor: z.string().nullable(),
  orphans: z.array(z.string()),
});

export function buildOrphansTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "find_orphans",
      domain: "links",
      description:
        "Find notes that nothing else links to (optionally also requiring no outgoing links); a link in a property counts. A note whose frontmatter is not valid YAML does not fail the scan: its body is still read and it is named in `warnings`.",
      inputSchema: z
        .object({
          vault: VaultId,
          folder: VaultPath.optional(),
          limit: z.number().int().positive().max(5000).default(DEFAULT_SCAN_LIMIT),
          cursor: z.string().optional(),
          require_no_outgoing: z.boolean().default(false),
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
        };
      },
    }),
  ];
}
