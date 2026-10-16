// Domain 17 — make.md (G2.1). Two read-side bridge tools that surface make.md's
// "spaces" model and run queries against them. Read scope only (read:makemd, no
// HITL). The community plugin id is "make-md" (note the hyphen), distinct from the
// makemd_ tool-name prefix.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import {
  filterBridgeItemsByAcl,
  filterBridgeResultItems,
  readEnumerationUnrestricted,
} from "../../vault/acl-read-filter";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge, parseBridgePayload } from "./shared";

const MakemdSpacesBridge = z.object({ spaces: z.array(z.unknown()) });
const MakemdListSpacesOutput = z
  .object({ vault: z.string(), spaces: z.array(z.unknown()) })
  .strict();
const MakemdQueryOutput = z
  .object({
    vault: z.string(),
    space_id: z.string(),
    items: z.array(z.unknown()),
    total: z.number().int(),
  })
  .strict();

export function buildMakeMdTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "makemd_list_spaces",
      domain: "automation",
      description:
        "Enumerate make.md spaces (its alternative to folders) via the companion bridge.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      outputSchema: MakemdListSpacesOutput,
      requiredScopes: ["read:makemd"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        // Spaces are not vault-path-scopable; refuse blanket enumeration under a read
        // whitelist rather than leak (D2/B2).
        if (!readEnumerationUnrestricted(ctx.acl, ctx.grantedScopes))
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
        const payload = parseBridgePayload(MakemdSpacesBridge, result, "make-md");
        const spaces = filterBridgeItemsByAcl(ctx.acl, v.root, ctx.grantedScopes, payload.spaces, {
          tool: "makemd_list_spaces",
        });
        return { vault: v.id, spaces };
      },
    }),

    defineTool({
      name: "makemd_query",
      domain: "automation",
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
          // instead of returning a usable first page. The default is a page that fits a client's ~20 KB
          // inline limit (mcp/result-size.ts); `.max()` stays the ceiling for a caller that asks.
          limit: z.number().int().positive().max(1000).default(50),
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
        // unattributable row under a read whitelist (D2/B2). Sibling fields are never exposed:
        // they are neither path-checked nor part of this tool's result contract.
        const filtered = filterBridgeResultItems(ctx.acl, v.root, ctx.grantedScopes, result, {
          tool: "makemd_query",
          keys: ["note_path", "path", "file", "filePath", "from"],
        });
        return { vault: v.id, space_id: input.space_id, ...filtered };
      },
    }),
  ];
}
