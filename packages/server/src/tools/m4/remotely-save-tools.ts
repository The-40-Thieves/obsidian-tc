// Domain 31 — Remotely Save bridge (THE-381). A second, independent backup signal next to
// restic/git: an agent can ask "did the last sync actually succeed" and kick a sync. Status is
// read:remotely-save; trigger is write:remotely-save (a sync is low-risk and non-destructive —
// no HITL floor, but the readOnly kill switch applies).
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge, parseBridgePayload } from "./shared";

const RemotelySaveStatusBridge = z.object({
  sync_status: z.string(),
  last_success_sync: z.number().nullable(),
});
const RemotelySaveTriggerBridge = z.object({ triggered: z.boolean(), fired_at: z.string() });
const RemotelySaveStatusOutput = RemotelySaveStatusBridge.extend({ vault: z.string() }).strict();
const RemotelySaveTriggerOutput = RemotelySaveTriggerBridge.extend({ vault: z.string() }).strict();

export function buildRemotelySaveTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "remotely_save_status",
      domain: "automation",
      description:
        "Last sync state of the Remotely Save plugin (sync status + last successful sync time) — an independent backup-verification signal, via the companion bridge.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      outputSchema: RemotelySaveStatusOutput,
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
        const payload = parseBridgePayload(RemotelySaveStatusBridge, result, "remotely-save");
        return { vault: v.id, ...payload };
      },
    }),

    defineTool({
      name: "remotely_save_trigger",
      domain: "automation",
      vaultArg: "vault",
      description:
        "Kick off a Remotely Save sync run (fire-and-poll: check remotely_save_status afterwards), via the companion bridge.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      outputSchema: RemotelySaveTriggerOutput,
      requiredScopes: ["write:remotely-save"],
      tags: ["external-network"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridge(deps, v.id, "remotely-save");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/remotely-save/trigger",
          plugin: "remotely-save",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        ctx.markEffectCommitted?.();
        const payload = parseBridgePayload(RemotelySaveTriggerBridge, result, "remotely-save");
        return { vault: v.id, ...payload };
      },
    }),
  ];
}
