// WP5.2 (issue 16): run_serve's M4 plugin-bridge client + capability-snapshot wiring, extracted
// verbatim out of cli.ts. Per vault: build a Local REST API client (when restApiUrl is configured)
// and probe it once at startup for its plugin-capability map; a vault with no restApiUrl gets no
// client, and its bridge tools then degrade to plugin_unreachable — the probe never throws, so a
// missing/unreachable companion only degrades the bridge tools, never startup. Built before M2
// registration (tool-wiring.ts) so search_dql can share the same Dataview bridge through the
// returned M4Deps — mirrors the map's "bridge clients and capability snapshots" step, which sits
// between indexing/watcher wiring and M1-M8 tool registration.
import type { VaultConfig } from "@the-40-thieves/obsidian-tc-shared";
import {
  type BridgeClient,
  buildVaultCapabilities,
  CapabilityCache,
  checkBridgeCompat,
  createBridgeClient,
  formatCompatWarning,
} from "../bridge";
import type { CapabilitySnapshot } from "../bridge/capabilities";
import { type BridgeTimeouts, DEFAULT_BRIDGE_TIMEOUTS, type M4Deps } from "../tools/m4";
import { resolveMode, type VaultMode } from "../vault/mode";
import type { VaultRegistry } from "../vault/registry";

export interface BridgeWiringDeps {
  /** config.vaults */
  vaults: VaultConfig[];
  /** THE-295/THE-210: owned by governance, constructed before this call. */
  vaultRegistry: VaultRegistry;
  /** THE-455: the index-on-write hook M4's update_task write path shares with M1 — owned by
   *  indexing-wiring.ts's wireIndexCoordinator, constructed just before this call. */
  reindex: (vaultId: string, path: string, content: string) => void;
}

export interface BridgeWiring {
  bridgeClients: Map<string, BridgeClient>;
  capabilities: CapabilityCache;
  /** THE-255: per-vault headless/live mode, resolved once at startup from the companion probe
   *  result captured below. */
  modeByVault: Map<string, VaultMode>;
  memoryFolderByVault: Map<string, string>;
  traceFolderByVault: Map<string, string>;
  /** The composed M4 deps object, ready to hand to registerM4Tools and to the M2/M3 bridge-proxy
   *  builders (dataviewBridge / templaterBridge) in tool-wiring.ts. */
  m4Deps: M4Deps;
}

/**
 * Build a bridge client per vault (when configured), probe each once for its plugin-capability
 * snapshot, warn once on a server<->companion version skew, then resolve per-vault headless/live
 * mode and compose the shared M4Deps object (bridgeFor/timeouts/commandPolicy/mode/reprobe).
 */
export async function wireBridges(deps: BridgeWiringDeps): Promise<BridgeWiring> {
  const bridgeClients = new Map<string, BridgeClient>();
  const timeoutsByVault = new Map<string, BridgeTimeouts>();
  const commandsByVault = new Map<string, { enabled: boolean; allowlist: string[] }>();
  const memoryFolderByVault = new Map<string, string>();
  const traceFolderByVault = new Map<string, string>();
  const capabilities = new CapabilityCache();
  for (const v of deps.vaults) {
    commandsByVault.set(v.id, {
      enabled: v.commands?.enabled ?? false,
      allowlist: v.commands?.allowlist ?? [],
    });
    if (v.memory) memoryFolderByVault.set(v.id, v.memory.folder);
    if (v.workspace) traceFolderByVault.set(v.id, v.workspace.traceFolder);
    if (v.bridges)
      timeoutsByVault.set(v.id, {
        timeoutMs: v.bridges.timeoutMs,
        ocrTimeoutMs: v.bridges.ocrTimeoutMs,
        templaterTimeoutMs: v.bridges.templaterTimeoutMs,
      });
    const client = v.restApiUrl
      ? createBridgeClient({
          baseUrl: v.restApiUrl,
          apiKey: v.restApiKey,
          timeoutMs: v.bridges?.timeoutMs,
        })
      : undefined;
    if (client) bridgeClients.set(v.id, client);
    const snap = await buildVaultCapabilities(client, {
      probeSkip: v.plugins?.probeSkip,
      forceEnabled: v.plugins?.forceEnabled,
      forceDisabled: v.plugins?.forceDisabled,
      timeoutMs: v.bridges?.probeTimeoutMs,
    });
    capabilities.set(v.id, snap);
    // THE-523 version handshake: warn ONCE per vault on a server↔plugin skew, with the specific
    // incompatibility, instead of letting a route diverge silently. A reachable-but-incompatible
    // companion is the only case that logs; missing/unreachable is bridge STATE, reported elsewhere.
    const compat = checkBridgeCompat(snap);
    if (compat.issues.length > 0) {
      process.stderr.write(`${formatCompatWarning(v.id, compat)}\n`);
    }
  }
  // Per-vault mode resolved once at startup (THE-255): explicit live/headless win; auto uses
  // the companion probe result captured above. Tier-3 bridge tools degrade headless.
  const modeByVault = new Map<string, VaultMode>(
    deps.vaults.map((v) => [
      v.id,
      resolveMode(
        { mode: v.mode, restApiUrl: v.restApiUrl },
        capabilities.get(v.id).companion === "reachable",
      ),
    ]),
  );
  // THE-527: re-probe a vault with the SAME config overrides used at startup, so
  // refresh_plugin_capabilities produces a snapshot consistent with a fresh boot. Unknown vault ->
  // an empty (companion-missing) snapshot rather than a throw.
  const vaultConfigById = new Map(deps.vaults.map((v) => [v.id, v]));
  const reprobeVault = async (vaultId: string): Promise<CapabilitySnapshot> => {
    const v = vaultConfigById.get(vaultId);
    if (!v) return { companion: "missing" as const, plugins: {} };
    return buildVaultCapabilities(bridgeClients.get(vaultId), {
      probeSkip: v.plugins?.probeSkip,
      forceEnabled: v.plugins?.forceEnabled,
      forceDisabled: v.plugins?.forceDisabled,
      timeoutMs: v.bridges?.probeTimeoutMs,
    });
  };

  const m4Deps: M4Deps = {
    reindex: deps.reindex,
    vaultRegistry: deps.vaultRegistry,
    capabilities,
    bridgeFor: (vaultId) => bridgeClients.get(vaultId),
    timeouts: (vaultId) => timeoutsByVault.get(vaultId) ?? DEFAULT_BRIDGE_TIMEOUTS,
    commandPolicy: (vaultId) => commandsByVault.get(vaultId) ?? { enabled: false, allowlist: [] },
    mode: (vaultId) => modeByVault.get(vaultId) ?? "headless",
    reprobe: reprobeVault,
  };

  return {
    bridgeClients,
    capabilities,
    modeByVault,
    memoryFolderByVault,
    traceFolderByVault,
    m4Deps,
  };
}
