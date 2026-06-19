// Domain 17 — make.md (G2.1). Two read-side bridge tools that surface make.md's
// "spaces" model and run queries against them. Read scope only (read:makemd, no
// HITL). The community plugin id is "make-md" (note the hyphen), distinct from the
// makemd_ tool-name prefix.
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { type M4Deps, bridgeTimeouts, openBridge } from "./shared";

export function buildMakeMdTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "makemd_list_spaces",
      description:
        "Enumerate make.md spaces (its alternative to folders) via the companion bridge.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["read:makemd"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
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
          filter: z.record(z.unknown()).optional(),
          sort: z.record(z.unknown()).optional(),
          limit: z.number().int().positive().max(1000).optional(),
          cursor: z.string().optional(),
        })
        .strict(),
      requiredScopes: ["read:makemd"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "make-md");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/makemd/query",
          body: {
            space_id: input.space_id,
            ...(input.filter ? { filter: input.filter } : {}),
            ...(input.sort ? { sort: input.sort } : {}),
            ...(input.limit ? { limit: input.limit } : {}),
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          plugin: "make-md",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, space_id: input.space_id, ...result };
      },
    }),
  ];
}
