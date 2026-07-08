// Domain 26 — Command palette dispatch (G2.1). The companion plugin exposes Obsidian's
// commands, so these tools gate on companion reachability (openCompanionBridge,
// plugin_unreachable). list_commands is a read-side enumeration. execute_command runs an
// arbitrary Obsidian command and is the most dangerous tool in M4 — it is DENY-BY-DEFAULT
// and triple-gated. The enable + allowlist gates run in a dispatch `precheck` (after
// scope/ACL, before HITL), so a rejected command never consumes the single-use elicit token:
//   1. the vault must explicitly enable command execution (precheck; default off);
//   2. the command id must be on the vault allowlist (precheck);
//   3. execute:command is a hardcoded HITL floor -> dispatch then demands a human token.
// Arbitrary command execution is therefore never silently runnable.
//
// LRA-native fallback (THE-383 / GitHub #155): the command palette is one of the few M4
// domains Local REST API implements ITSELF — GET /commands/ and POST /commands/{id}/, at
// the server root with no /obsidian-tc/v1 companion prefix. When the companion bridge is
// unreachable we fall back to those native routes so list/execute keep working against a
// bare LRA with no (or a broken) companion. The fallback runs AFTER execute_command's
// security gates (they short-circuit in precheck), so it grants no new capability.
import { err, ObsidianTcError, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { BridgeClient } from "../../bridge";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, commandPolicy, type M4Deps, openCompanionBridge } from "./shared";

// Degrade codes that mean "no working companion path" and so warrant an LRA-native retry:
// the snapshot says the companion is missing/unreachable (plugin_unreachable) or the vault
// is headless (requires_live_obsidian). A plugin_incompatible companion is a deliberate
// "update it" signal and is NOT retried.
const COMPANION_UNREACHABLE: ReadonlySet<string> = new Set([
  "plugin_unreachable",
  "requires_live_obsidian",
]);

function companionUnreachable(e: unknown): boolean {
  return e instanceof ObsidianTcError && COMPANION_UNREACHABLE.has(e.code);
}

interface LraCommand {
  id: string;
  name: string;
}
interface LraCommandList {
  commands?: LraCommand[];
}

// GET LRA /commands/ and shape it like the companion's /commands/list envelope
// ({ items, total }), applying the same case-insensitive substring filter the companion
// applies server-side. `source` marks the degraded path for observability.
async function listCommandsNative(
  client: BridgeClient,
  filter: string | undefined,
  timeoutMs: number,
): Promise<{ items: LraCommand[]; total: number; source: "local-rest-api" }> {
  const res = await client.requestNative<LraCommandList>({
    method: "GET",
    path: "/commands/",
    timeoutMs,
    plugin: "local-rest-api",
  });
  if (!res.ok)
    throw err.pluginUnreachable("local-rest-api /commands/ is unavailable", {
      plugin: "local-rest-api",
      http_status: res.status,
    });
  const f = filter?.toLowerCase();
  const items = (res.data?.commands ?? [])
    .map((c) => ({ id: c.id, name: c.name }))
    .filter((c) => !f || c.id.toLowerCase().includes(f) || c.name.toLowerCase().includes(f));
  return { items, total: items.length, source: "local-rest-api" };
}

// POST LRA /commands/{id}/ (204 on success). Any non-2xx — including a 404, which is
// ambiguous between "unknown command" and "this LRA has no native command route" — is
// treated as native-unavailable so the caller falls through to the companion degrade
// (with its actionable hint) rather than mislabeling the failure.
async function executeCommandNative(
  client: BridgeClient,
  commandId: string,
  timeoutMs: number,
): Promise<{ command_id: string; fired_at: string; source: "local-rest-api" }> {
  const res = await client.requestNative({
    method: "POST",
    path: `/commands/${encodeURIComponent(commandId)}/`,
    timeoutMs,
    plugin: "local-rest-api",
  });
  if (!res.ok)
    throw err.pluginUnreachable("local-rest-api command execution failed", {
      plugin: "local-rest-api",
      http_status: res.status,
    });
  return { command_id: commandId, fired_at: new Date().toISOString(), source: "local-rest-api" };
}

export function buildCommandTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_commands",
      description:
        "Enumerate available Obsidian commands (optional substring filter). Uses the companion plugin, falling back to Local REST API's native /commands/ route when the companion is unreachable.",
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
        try {
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
        } catch (e) {
          // Companion unreachable -> retry via LRA's native /commands/ if a transport exists.
          const client = deps.bridgeFor(v.id);
          if (!(client && companionUnreachable(e))) throw e;
          const native = await listCommandsNative(
            client,
            input.filter,
            bridgeTimeouts(deps, v.id).timeoutMs,
          ).catch(() => null);
          if (native) return { vault: v.id, ...native };
          throw e; // LRA native also unavailable -> surface the original companion degrade.
        }
      },
    }),

    defineTool({
      name: "execute_command",
      description:
        "Fire an Obsidian command by id. Deny-by-default and triple-gated: requires human confirmation (execute:command is a HITL floor), command execution must be enabled for the vault, and the id must be on the vault allowlist. Falls back to Local REST API's native /commands/{id}/ route when the companion is unreachable. Never silently runnable.",
      inputSchema: z
        .object({
          vault: VaultId,
          command_id: z.string().min(1),
          args: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
      requiredScopes: ["execute:command"],
      // Deny-by-default policy runs in precheck (D5): dispatch invokes it AFTER scope/ACL
      // and BEFORE the HITL elicit consumption, so a disabled / not-allowlisted command is
      // rejected without burning the single-use confirmation token.
      precheck: (input) => {
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
      },
      handler: async (input) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        try {
          const { client } = openCompanionBridge(deps, v.id);
          const result = await client.request<Record<string, unknown>>({
            method: "POST",
            path: "/commands/execute",
            body: { command_id: input.command_id, ...(input.args ? { args: input.args } : {}) },
            plugin: "obsidian-tc-companion",
            timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
          });
          return { vault: v.id, command_id: input.command_id, ...result };
        } catch (e) {
          // Gates already passed (precheck + HITL). Companion unreachable -> try LRA native.
          const client = deps.bridgeFor(v.id);
          if (!(client && companionUnreachable(e))) throw e;
          const native = await executeCommandNative(
            client,
            input.command_id,
            bridgeTimeouts(deps, v.id).timeoutMs,
          ).catch(() => null);
          if (native) return { vault: v.id, ...native };
          throw e; // LRA native also unavailable -> surface the original companion degrade.
        }
      },
    }),
  ];
}
