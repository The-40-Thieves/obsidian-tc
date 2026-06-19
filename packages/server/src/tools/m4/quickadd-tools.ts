// Domain 14 — QuickAdd (G2.1). list_quickadd_actions enumerates configured actions
// (read:quickadd, no HITL). trigger_quickadd fires an action by name; QuickAdd
// actions can create/modify notes broadly and run macros, so it carries
// execute:quickadd — the execute family is a hardcoded HITL floor, so dispatch
// ALWAYS requires a human elicit token first. Never silently executable.
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { type M4Deps, bridgeTimeouts, openBridge } from "./shared";

export function buildQuickAddTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_quickadd_actions",
      description:
        "Enumerate configured QuickAdd actions (template/macro/capture/multi) via the companion bridge.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["read:quickadd"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "quickadd");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/quickadd/actions",
          plugin: "quickadd",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),

    defineTool({
      name: "trigger_quickadd",
      description:
        "Fire a QuickAdd action by name. Always requires human confirmation (execute:quickadd is a HITL floor): actions can create or modify notes broadly and run macros.",
      inputSchema: z
        .object({
          vault: VaultId,
          action_name: z.string().min(1),
          args: z.record(z.unknown()).optional(),
        })
        .strict(),
      requiredScopes: ["execute:quickadd"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "quickadd");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/quickadd/trigger",
          body: { action_name: input.action_name, ...(input.args ? { args: input.args } : {}) },
          plugin: "quickadd",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, action_name: input.action_name, ...result };
      },
    }),
  ];
}
