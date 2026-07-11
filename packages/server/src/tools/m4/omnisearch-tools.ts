// Domain 6 (search) — Omnisearch bridge. Ranked full-text search over the vault via
// the Omnisearch plugin's public search() API, proxied through the companion's
// /omnisearch/search route. Read scope only (read:omnisearch, no HITL floor) — it does
// not mutate the vault. Degrades via the capability gate (plugin_missing /
// plugin_unreachable) when Omnisearch or the companion is absent.
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

export function buildOmnisearchTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "search_omnisearch",
      description:
        "Ranked full-text search over the vault via the Omnisearch plugin. Returns scored matches with per-note excerpts and matched words. Complements the built-in search domain with Omnisearch's own ranking.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1),
          limit: z.number().int().positive().max(100).optional(),
        })
        .strict(),
      requiredScopes: ["read:omnisearch"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "omnisearch");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/omnisearch/search",
          body: { query: input.query, ...(input.limit ? { limit: input.limit } : {}) },
          plugin: "omnisearch",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),
  ];
}
