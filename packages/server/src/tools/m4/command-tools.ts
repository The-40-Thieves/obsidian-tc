// Domain 26 — Command palette dispatch (G2.1). The companion plugin itself exposes
// Obsidian's commands, so these gate on companion reachability (openCompanionBridge,
// plugin_unreachable) rather than a community plugin. list_commands is a read-side
// enumeration. execute_command runs an arbitrary Obsidian command and is the most
// dangerous tool in M4 — it is DENY-BY-DEFAULT and triple-gated:
//   1. execute:command is a hardcoded HITL floor -> dispatch demands a human token;
//   2. the vault must explicitly enable command execution (config, default off);
//   3. the command id must be on the vault allowlist.
// Arbitrary command execution is therefore never silently runnable.
import { VaultId, err } from "@obsidian-tc/shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { type M4Deps, bridgeTimeouts, commandPolicy, openCompanionBridge } from "./shared";

export function buildCommandTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_commands",
      description:
        "Enumerate available Obsidian commands via the companion plugin (optional substring filter). Requires the companion; no community plugin needed.",
      inputSchema: z
        .object({
          vault: VaultId,
          filter: z.string().optional(),
          limit: z.number().int().positive().max(1000).optional(),
          cursor: z.string().optional(),
        })
        .strict(),
      requiredScopes: ["read:command"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openCompanionBridge(deps, v.id);
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/commands/list",
          body: {
            ...(input.filter ? { filter: input.filter } : {}),
            ...(input.limit ? { limit: input.limit } : {}),
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          plugin: "obsidian-tc-companion",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),

    defineTool({
      name: "execute_command",
      description:
        "Fire an Obsidian command by id. Deny-by-default and triple-gated: requires human confirmation (execute:command is a HITL floor), command execution must be enabled for the vault, and the id must be on the vault allowlist. Never silently runnable.",
      inputSchema: z
        .object({
          vault: VaultId,
          command_id: z.string().min(1),
          args: z.record(z.unknown()).optional(),
        })
        .strict(),
      requiredScopes: ["execute:command"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const policy = commandPolicy(deps, v.id);
        if (!policy.enabled)
          throw err.executeCommandDisabled("command execution is disabled for this vault", {
            vault: v.id,
          });
        if (!policy.allowlist.includes(input.command_id))
          throw err.commandNotAllowlisted("command is not in the vault allowlist", {
            command_id: input.command_id,
          });
        const { client } = openCompanionBridge(deps, v.id);
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/commands/execute",
          body: { command_id: input.command_id, ...(input.args ? { args: input.args } : {}) },
          plugin: "obsidian-tc-companion",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, command_id: input.command_id, ...result };
      },
    }),
  ];
}
