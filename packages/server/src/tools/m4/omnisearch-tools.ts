// Domain 6 (search) — Omnisearch bridge. Ranked full-text search over the vault via
// the Omnisearch plugin's public search() API, proxied through the companion's
// /omnisearch/search route. Read scope only (read:omnisearch, no HITL floor) — it does
// not mutate the vault. Degrades via the capability gate (plugin_missing /
// plugin_unreachable) when Omnisearch or the companion is absent.
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { filterBridgeResultItems } from "../../vault/acl-read-filter";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

export function buildOmnisearchTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "search_omnisearch",
      domain: "search",
      description:
        "Ranked full-text search over the vault via the Omnisearch plugin. Returns scored matches with per-note excerpts and matched words. Complements the built-in search domain with Omnisearch's own ranking.",
      inputSchema: z
        .object({
          vault: VaultId,
          query: z.string().min(1),
          // THE-516: default the page size to this tool's own cap rather than leaving it absent.
          // Forwarding no limit let the REMOTE plugin decide how much to return, which obsidian-tc
          // cannot bound — the byte governor then rejects an oversized response as `overflow`
          // instead of returning a usable first page. The default is a page that fits a client's ~20 KB
          // inline limit (mcp/result-size.ts); `.max()` stays the ceiling for a caller that asks.
          limit: z.number().int().positive().max(100).default(50),
        })
        .strict(),
      // The companion's /omnisearch/search response (scored matches + excerpts) is arbitrary
      // plugin JSON passed through verbatim; only `vault` is structurally guaranteed.
      outputSchema: z.object({ vault: z.string() }).passthrough(),
      requiredScopes: ["read:omnisearch"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "omnisearch");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/omnisearch/search",
          body: { query: input.query, limit: input.limit },
          plugin: "omnisearch",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        // Scored rows carry a note path and an excerpt of its text: keep only what this caller may
        // read, refuse an unattributable row under a restricted read.
        return {
          vault: v.id,
          ...filterBridgeResultItems(ctx.acl, v.root, ctx.grantedScopes, result, {
            tool: "search_omnisearch",
          }),
        };
      },
    }),
  ];
}
