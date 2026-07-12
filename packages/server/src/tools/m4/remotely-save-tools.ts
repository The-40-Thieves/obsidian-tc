// Domain 31 — Remotely Save bridge (THE-381). A second, independent backup signal next to
// restic/git: an agent can ask "did the last sync actually succeed" and kick a sync. Status is
// read:remotely-save; trigger is write:remotely-save (a sync is low-risk and non-destructive —
// no HITL floor, but the readOnly kill switch applies).
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

export function buildRemotelySaveTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "remotely_save_status",
      description:
        "Last sync state of the Remotely Save plugin (sync status + last successful sync time) — an independent backup-verification signal, via the companion bridge.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["read:remotely-save"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "remotely-save");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/remotely-save/status",
          plugin: "remotely-save",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),

    defineTool({
      name: "remotely_save_trigger",
      description:
        "Kick off a Remotely Save sync run (fire-and-poll: check remotely_save_status afterwards), via the companion bridge.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["write:remotely-save"],
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "remotely-save");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/remotely-save/trigger",
          plugin: "remotely-save",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, ...result };
      },
    }),
  ];
}
