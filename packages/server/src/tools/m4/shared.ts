// Shared wiring for the M4 plugin-bridge tools (THE-180). M4Deps is injected once
// in cli.ts onto the same ToolRegistry as M0-M3, so the bridge tools light up on
// both the stdio and HTTP edges. openBridge is the gate every bridge-proxy tool
// runs first: it degrades (plugin_missing / plugin_unreachable) via the probed
// capability snapshot before any network call, and yields the per-vault client.
import { err } from "@obsidian-tc/shared";
import { type BridgeClient, type CapabilityCache, requirePlugin } from "../../bridge";
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

export interface M4Deps {
  vaultRegistry: VaultRegistry;
  capabilities: CapabilityCache;
  /** Per-vault bridge client; undefined when the vault configures no REST endpoint. */
  bridgeFor: (vaultId: string) => BridgeClient | undefined;
  /** Per-vault timeouts; defaults applied when omitted. */
  timeouts?: (vaultId: string) => BridgeTimeouts;
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
  const cap = requirePlugin(deps.capabilities.get(vaultId), plugin);
  const client = deps.bridgeFor(vaultId);
  if (!client) throw err.pluginUnreachable("bridge transport not configured", { plugin });
  return { client, ...cap };
}

export function bridgeTimeouts(deps: M4Deps, vaultId: string): BridgeTimeouts {
  return deps.timeouts?.(vaultId) ?? DEFAULT_BRIDGE_TIMEOUTS;
}
