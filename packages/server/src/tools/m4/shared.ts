// Shared wiring for the M4 plugin-bridge tools (THE-180). M4Deps is injected once
// in cli.ts onto the same ToolRegistry as M0-M3, so the bridge tools light up on
// both the stdio and HTTP edges. openBridge is the gate every bridge-proxy tool
// runs first: it degrades (plugin_missing / plugin_unreachable) via the probed
// capability snapshot before any network call, and yields the per-vault client.
import { err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { type BridgeClient, type CapabilityCache, requirePlugin } from "../../bridge";
import { assertLive, type VaultMode } from "../../vault/mode";
import type { VaultRegistry } from "../../vault/registry";

export interface BridgeTimeouts {
  timeoutMs: number;
  ocrTimeoutMs: number;
  templaterTimeoutMs: number;
}

export const DEFAULT_BRIDGE_TIMEOUTS: BridgeTimeouts = {
  timeoutMs: 5000,
  ocrTimeoutMs: 30000,
  templaterTimeoutMs: 30000,
};

export interface CommandPolicy {
  enabled: boolean;
  allowlist: string[];
}

export interface M4Deps {
  vaultRegistry: VaultRegistry;
  capabilities: CapabilityCache;
  /** Per-vault bridge client; undefined when the vault configures no REST endpoint. */
  bridgeFor: (vaultId: string) => BridgeClient | undefined;
  /** Per-vault timeouts; defaults applied when omitted. */
  timeouts?: (vaultId: string) => BridgeTimeouts;
  /** Per-vault command-palette execution policy; deny-by-default when omitted. */
  commandPolicy?: (vaultId: string) => CommandPolicy;
  /** Per-vault headless/live mode (THE-255). When headless, the bridge tools have no app to
   *  proxy to and degrade to requires_live_obsidian. Omitted in tests -> no mode gate. */
  mode?: (vaultId: string) => VaultMode;
  /** THE-291: index-on-write hook for update_task's note rewrite (best-effort, backgrounded). */
  reindex?: (vaultId: string, path: string, content: string) => void;
}

/**
 * Resolve a usable bridge client for `plugin` on `vaultId`, or throw a degraded
 * error. requirePlugin maps an absent/unreachable plugin onto the error taxonomy
 * from the capability snapshot; a configured-available plugin with no transport
 * (misconfiguration) degrades to plugin_unreachable.
 */
export function openBridge(
  deps: M4Deps,
  vaultId: string,
  plugin: string,
): { client: BridgeClient; version?: string } {
  // THE-255: a headless vault has no live app to proxy to — degrade visibly before any
  // capability/network work, so clients see requires_live_obsidian rather than a probe miss.
  const mode = deps.mode?.(vaultId);
  if (mode) assertLive(mode, plugin);
  const cap = requirePlugin(deps.capabilities.get(vaultId), plugin);
  const client = deps.bridgeFor(vaultId);
  if (!client) throw err.pluginUnreachable("bridge transport not configured", { plugin });
  return { client, ...cap };
}

export function bridgeTimeouts(deps: M4Deps, vaultId: string): BridgeTimeouts {
  return deps.timeouts?.(vaultId) ?? DEFAULT_BRIDGE_TIMEOUTS;
}

/**
 * If `e` is a plugin_missing / plugin_unreachable / requires_live_obsidian degrade, return a copy with an actionable
 * `hint` added to its details (e.g. a native alternative tool to use instead); otherwise return
 * `e` unchanged. Lets a bridge tool point callers at a fallback without changing the degrade
 * code or its retryability.
 */
export function withDegradeHint(e: unknown, hint: string): unknown {
  if (
    e instanceof ObsidianTcError &&
    (e.code === "plugin_missing" ||
      e.code === "plugin_unreachable" ||
      e.code === "requires_live_obsidian")
  ) {
    return new ObsidianTcError(e.code, e.message, { ...e.details, hint });
  }
  return e;
}

/** openBridge, but a plugin_missing/plugin_unreachable degrade carries `hint` in its details. */
export function openBridgeWithHint(
  deps: M4Deps,
  vaultId: string,
  plugin: string,
  hint: string,
): { client: BridgeClient; version?: string } {
  try {
    return openBridge(deps, vaultId, plugin);
  } catch (e) {
    throw withDegradeHint(e, hint);
  }
}

/**
 * Resolve a usable bridge client for a companion-core capability (e.g. the command
 * palette), or throw plugin_unreachable. Unlike openBridge there is no community
 * plugin to check — the companion itself provides the capability — so a missing OR
 * unreachable companion both degrade to plugin_unreachable (Domain 26 spec).
 */
export function openCompanionBridge(deps: M4Deps, vaultId: string): { client: BridgeClient } {
  const mode = deps.mode?.(vaultId);
  if (mode) assertLive(mode, "obsidian-tc-companion");
  const snap = deps.capabilities.get(vaultId);
  if (snap.companion !== "reachable") {
    const hint =
      snap.companion === "missing"
        ? "install it with `obsidian-tc plugin install --vault <path>`, then enable it in Obsidian."
        : "the companion is installed but its Local REST API is unreachable; check that Obsidian is running with the plugin enabled.";
    throw err.pluginUnreachable("companion plugin is required for this tool", {
      plugin: "obsidian-tc-companion",
      companion: snap.companion,
      hint,
    });
  }
  const client = deps.bridgeFor(vaultId);
  if (!client)
    throw err.pluginUnreachable("bridge transport not configured", {
      plugin: "obsidian-tc-companion",
    });
  return { client };
}

/** Per-vault command-execution policy; deny-by-default (disabled, empty allowlist). */
export function commandPolicy(deps: M4Deps, vaultId: string): CommandPolicy {
  return deps.commandPolicy?.(vaultId) ?? { enabled: false, allowlist: [] };
}
