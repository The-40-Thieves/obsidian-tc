// Domain 26 (companion-core) — Daily Notes bridge. Resolves the daily note for a date via the
// core Daily Notes plugin's configured folder + format, through the companion
// /daily-notes/resolve route. Companion-core capability (openCompanionBridge): degrades to
// plugin_unreachable when the companion is absent or core Daily Notes is disabled. Read-only.
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openCompanionBridge } from "./shared";

export function buildDailyNotesTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "resolve_daily_note",
      description:
        "Resolve the daily note for a date (default today) via the core Daily Notes plugin's configured folder + format. Returns whether it exists and its path — no path guessing. Read-only; does not create.",
      inputSchema: z.object({ vault: VaultId, date: z.string().optional() }).strict(),
      requiredScopes: ["read:daily-notes"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openCompanionBridge(deps, v.id);
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/daily-notes/resolve",
          body: { ...(input.date ? { date: input.date } : {}) },
          plugin: "obsidian-tc-companion",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),
  ];
}
