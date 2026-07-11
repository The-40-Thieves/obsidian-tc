// Domain 10 (dataview/datacore) — Datacore bridge. Runs a query in Datacore's own
// query language (Dataview's successor) via the plugin's DatacoreApi.tryQuery, proxied
// through the companion /datacore/query route. Read scope only (read:datacore); degrades
// via the capability gate when Datacore or the companion is absent.
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

export function buildDatacoreTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "query_datacore",
      description:
        "Run a Datacore query using its own query language (e.g. `@page and #tag`, `@task and $completed = false`) and return matching pages/blocks with their path, name, tags, types, and frontmatter fields. Datacore is Dataview's successor; use search_dql for classic Dataview DQL.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1),
          limit: z.number().int().positive().max(500).optional(),
        })
        .strict(),
      requiredScopes: ["read:datacore"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "datacore");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/datacore/query",
          body: { query: input.query, ...(input.limit ? { limit: input.limit } : {}) },
          plugin: "datacore",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),
  ];
}
