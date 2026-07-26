// Domain 17 — make.md (G2.1). Two read-side bridge tools that surface make.md's
// "spaces" model and run queries against them. Read scope only (read:makemd, no
// HITL). The community plugin id is "make-md" (note the hyphen), distinct from the
// makemd_ tool-name prefix.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { filterBridgeItemsByAcl, readEnumerationUnrestricted } from "../../vault/acl-read-filter";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

// THE-417: makemd_list_spaces proxies the companion's own JSON verbatim (arbitrary, passthrough).
// makemd_query ACL-filters the plugin's rows (readEnumerationUnrestricted gates whether the
// unfiltered `...result` siblings are also spread), but items/total are ALWAYS the ACL-filtered,
// recomputed values overriding whatever raw items/total the plugin sent — both branches guarantee
// vault/space_id/items/total; the passthrough covers the plugin's other, arbitrary sibling fields.
const MakemdListSpacesOutput = z.object({ vault: z.string() }).passthrough();
const MakemdQueryOutput = z
  .object({
    vault: z.string(),
    space_id: z.string(),
    items: z.array(z.unknown()),
    total: z.number().int(),
  })
  .passthrough();

export function buildMakeMdTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "makemd_list_spaces",
      description:
        "Enumerate make.md spaces (its alternative to folders) via the companion bridge.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      outputSchema: MakemdListSpacesOutput,
      requiredScopes: ["read:makemd"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        // Spaces are not vault-path-scopable; refuse blanket enumeration under a read
        // whitelist rather than leak (D2/B2).
        if (!readEnumerationUnrestricted(ctx.acl))
          throw err.aclDenied(
            "make.md space enumeration is not path-scopable; refused under a read whitelist",
            { tool: "makemd_list_spaces" },
          );
        const { client } = openBridge(deps, v.id, "make-md");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/makemd/spaces",
          plugin: "make-md",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),

    defineTool({
      name: "makemd_query",
      description:
        "Run a make.md query against a space (filter/sort/paginate) via the companion bridge.",
      inputSchema: z
        .object({
          vault: VaultId,
          space_id: z.string().min(1),
          filter: z.record(z.string(), z.unknown()).optional(),
          sort: z.record(z.string(), z.unknown()).optional(),
          // THE-516: default the page size to this tool's own cap rather than leaving it absent.
          // Forwarding no limit let the REMOTE plugin decide how much to return, which obsidian-tc
          // cannot bound — the byte governor then rejects an oversized response as `overflow`
          // instead of returning a usable first page. Defaulting to the existing .max() keeps every
          // request that fits today working unchanged, while making the ceiling ours.
          limit: z.number().int().positive().max(1000).default(1000),
          cursor: z.string().optional(),
        })
        .strict(),
      outputSchema: MakemdQueryOutput,
      requiredScopes: ["read:makemd"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "make-md");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/makemd/query",
          body: {
            space_id: input.space_id,
            ...(input.filter ? { filter: input.filter } : {}),
            ...(input.sort ? { sort: input.sort } : {}),
            limit: input.limit,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          plugin: "make-md",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        // Intersect make.md rows with the read ACL by note path; fail closed on an
        // unattributable row under a read whitelist (D2/B2).
        const rawItems = Array.isArray(result.items) ? (result.items as unknown[]) : [];
        const items = filterBridgeItemsByAcl(ctx.acl, rawItems, {
          tool: "makemd_query",
          keys: ["note_path", "path", "file", "filePath"],
        });
        // Under a read whitelist, drop `...result` siblings — they can carry path-attributable
        // content from the UNFILTERED make.md rows (THE-270).
        if (!readEnumerationUnrestricted(ctx.acl))
          return { vault: v.id, space_id: input.space_id, items, total: items.length };
        return { vault: v.id, space_id: input.space_id, ...result, items, total: items.length };
      },
    }),
  ];
}
