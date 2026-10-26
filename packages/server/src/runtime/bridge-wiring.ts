// WP5.2 (issue 16): run_serve's M4 plugin-bridge client + capability-snapshot wiring, extracted
// verbatim out of cli.ts. Per vault: build a Local REST API client (when restApiUrl is configured)
// and probe it once at startup for its plugin-capability map; a vault with no restApiUrl gets no
// client, and its bridge tools then degrade to plugin_unreachable — the probe never throws, so a
// missing/unreachable companion only degrades the bridge tools, never startup. Built before M2
// registration (tool-wiring.ts) so search_dql can share the same Dataview bridge through the
// returned M4Deps — mirrors the map's "bridge clients and capability snapshots" step, which sits
// between indexing/watcher wiring and M1-M8 tool registration.
import type {
  VaultConfig,
  VaultMemoryDefenseConfig,
  VaultReflectConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import {
  type BridgeClient,
  type BridgeFetch,
  buildVaultCapabilities,
  CapabilityCache,
  checkBridgeCompat,
  createBridgeClient,
  formatCompatWarning,
} from "../bridge";
import type { CapabilitySnapshot } from "../bridge/capabilities";
import { MEMORY_DEFENSE_OFF } from "../experiential/memory-defense";
import type { MetricsRecorder } from "../metrics/registry";
import type { Scheduler } from "../scheduler/scheduler";
import { type BridgeTimeouts, DEFAULT_BRIDGE_TIMEOUTS, type M4Deps } from "../tools/m4";
import { resolveMode } from "../vault/mode";
import type { VaultRegistry } from "../vault/registry";

export interface BridgeWiringDeps {
  /** config.vaults */
  vaults: VaultConfig[];
  /** THE-295/THE-210: owned by governance, constructed before this call. */
  vaultRegistry: VaultRegistry;
  /** THE-455: the index-on-write hook M4's update_task write path shares with M1 — owned by
   *  indexing-wiring.ts's wireIndexCoordinator, constructed just before this call. */
  reindex: (vaultId: string, path: string, content: string) => void;
  /** update_task's memoryDefense guard, the same recorder every other memoryDefense
   *  seam gets. Absent -> no hit-counter tagging (the scan itself still runs off the vault's own
   *  memoryDefenseByVault entry below). */
  metrics?: MetricsRecorder;
  /** Transport seam for the bridge clients (tests inject a fake companion). Absent -> real fetch. */
  fetchFn?: BridgeFetch;
}

/** Background re-probe cadence for a bridged vault whose companion is not reachable. It is also
 *  the cooldown between two probes of the same vault. */
export const BRIDGE_REPROBE_INTERVAL_MS = 60_000;

export interface BridgeReprobeDeps {
  capabilities: CapabilityCache;
  reprobe: (vaultId: string) => Promise<CapabilitySnapshot>;
  /** Vaults that have a bridge transport. A vault without one has no companion to find. */
  vaultIds: readonly string[];
}

export interface BridgeWiring {
  bridgeClients: Map<string, BridgeClient>;
  capabilities: CapabilityCache;
  /** THE-527: re-probe one vault with its config overrides. Shared by refresh_plugin_capabilities
   *  and the background re-probe job (registerBridgeReprobe). */
  reprobeVault: (vaultId: string) => Promise<CapabilitySnapshot>;
  memoryFolderByVault: Map<string, string>;
  /** memory.supersededInNote, present only for a vault that configured a `memory` block. */
  supersededInNoteByVault: Map<string, boolean>;
  traceFolderByVault: Map<string, string>;
  /** GH #994: per-vault memoryDefense config, present only for a vault that configured one. */
  memoryDefenseByVault: Map<string, VaultMemoryDefenseConfig>;
  /** Per-vault reflect style defaults, present only for a vault that configured a `reflect` block. */
  reflectDefaultsByVault: Map<string, VaultReflectConfig>;
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
  const supersededInNoteByVault = new Map<string, boolean>();
  const traceFolderByVault = new Map<string, string>();
  const memoryDefenseByVault = new Map<string, VaultMemoryDefenseConfig>();
  const reflectDefaultsByVault = new Map<string, VaultReflectConfig>();
  const capabilities = new CapabilityCache();
  for (const v of deps.vaults) {
    commandsByVault.set(v.id, {
      enabled: v.commands?.enabled ?? false,
      allowlist: v.commands?.allowlist ?? [],
    });
    if (v.memory) memoryFolderByVault.set(v.id, v.memory.folder);
    if (v.memory) supersededInNoteByVault.set(v.id, v.memory.supersededInNote);
    if (v.workspace) traceFolderByVault.set(v.id, v.workspace.traceFolder);
    if (v.memoryDefense) memoryDefenseByVault.set(v.id, v.memoryDefense);
    if (v.reflect) reflectDefaultsByVault.set(v.id, v.reflect);
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
          fetchFn: deps.fetchFn,
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
    // A failed boot probe is logged with its cause code only: the URL and API key never reach it.
    if (snap.companion === "unreachable") {
      const cause = snap.unreachableCause ? ` (${snap.unreachableCause})` : "";
      process.stderr.write(`obsidian-tc: vault "${v.id}" companion unreachable at boot${cause}\n`);
    }
    // THE-523 version handshake: warn ONCE per vault on a server↔plugin skew, with the specific
    // incompatibility, instead of letting a route diverge silently. A reachable-but-incompatible
    // companion is the only case that logs; missing/unreachable is bridge STATE, reported elsewhere.
    const compat = checkBridgeCompat(snap);
    if (compat.issues.length > 0) {
      process.stderr.write(`${formatCompatWarning(v.id, compat)}\n`);
    }
  }
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
    // THE-255, resolved per call: the mode follows the LIVE snapshot, so a refresh or background
    // re-probe that finds the companion reachable takes effect without a restart. Explicit
    // live/headless still win. Tier-3 bridge tools degrade headless.
    mode: (vaultId) => {
      const v = vaultConfigById.get(vaultId);
      if (!v) return "headless";
      return resolveMode(
        { mode: v.mode, restApiUrl: v.restApiUrl },
        capabilities.get(vaultId).companion === "reachable",
      );
    },
    reprobe: reprobeVault,
    // update_task's memoryDefense guard — same "closure, defaulted at the read site"
    // shape every other memoryDefense seam uses.
    memoryDefense: (vaultId) => memoryDefenseByVault.get(vaultId) ?? MEMORY_DEFENSE_OFF,
    metrics: deps.metrics,
  };

  return {
    bridgeClients,
    capabilities,
    reprobeVault,
    memoryFolderByVault,
    supersededInNoteByVault,
    traceFolderByVault,
    memoryDefenseByVault,
    reflectDefaultsByVault,
    m4Deps,
  };
}

/** The vaults the background re-probe covers: bridged vaults not pinned headless. The live gate never
 *  reads a headless vault's snapshot, so probing one would be wasted traffic. */
export function reprobeVaultIds(
  vaults: readonly { id: string; mode?: string }[],
  bridged: ReadonlyMap<string, unknown>,
): string[] {
  return vaults.filter((v) => bridged.has(v.id) && v.mode !== "headless").map((v) => v.id);
}

/** Re-probe each bridged vault whose companion is not reachable, once per cooldown, until it
 *  answers. A reachable vault is skipped, so the job goes idle on its own. The scheduler's timer
 *  is unref'd and stopped with it, so this never holds the process open. No vault, no job. */
export function registerBridgeReprobe(scheduler: Scheduler, deps: BridgeReprobeDeps): void {
  if (deps.vaultIds.length === 0) return;
  scheduler.register({
    name: "bridge-reprobe",
    intervalMs: BRIDGE_REPROBE_INTERVAL_MS,
    run: async (signal) => {
      for (const vaultId of deps.vaultIds) {
        // stop() aborts the tick: no further vault starts a probe after it.
        if (signal.aborted) return;
        if (deps.capabilities.get(vaultId).companion === "reachable") continue;
        // Compare-and-set: a manual refresh that lands while this probe is in flight is newer.
        const before = deps.capabilities.get(vaultId);
        const next = await deps.reprobe(vaultId);
        if (deps.capabilities.get(vaultId) === before) deps.capabilities.set(vaultId, next);
      }
    },
  });
}
