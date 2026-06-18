// Startup auto-probe (M4 / THE-180, G2.2 §6). A single GET /obsidian-tc/v1/probe
// returns the companion plugin's capability map in one round trip (the companion
// already holds the inventory via app.plugins, so there is no per-endpoint HEAD
// fan-out). On the default 500ms timeout an unreachable probe is retried once at
// 200ms before the vault is marked bridges-unavailable; a 404 / explicit
// plugin_missing means the companion is not installed. The probe never throws —
// failure degrades the vault's bridge tools, it does not crash startup.
import { ObsidianTcError } from "@obsidian-tc/shared";
import {
  type CapabilitySnapshot,
  type PluginCapability,
  type PluginOverrides,
  applyOverrides,
} from "./capabilities";
import type { BridgeClient } from "./transport";

interface ProbeResponseResult {
  plugin_version?: string;
  obsidian_version?: string;
  obsidianTcApiVersion?: string;
  vault_path?: string;
  capabilities?: Record<string, { installed?: boolean; version?: string } | undefined>;
}

export interface ProbeOptions {
  /** First-attempt timeout; defaults to 500ms (G2.2 §6). */
  timeoutMs?: number;
  /** Retry timeout used once after an unreachable first attempt; defaults to 200ms. */
  retryTimeoutMs?: number;
}

function normalizeCapabilities(
  raw: ProbeResponseResult["capabilities"],
): Record<string, PluginCapability> {
  const out: Record<string, PluginCapability> = {};
  for (const [name, cap] of Object.entries(raw ?? {})) {
    out[name] = cap?.version
      ? { installed: cap.installed === true, version: cap.version }
      : { installed: cap?.installed === true };
  }
  return out;
}

function snapshotFrom(r: ProbeResponseResult): CapabilitySnapshot {
  return {
    companion: "reachable",
    plugins: normalizeCapabilities(r.capabilities),
    ...(r.plugin_version ? { pluginVersion: r.plugin_version } : {}),
    ...(r.obsidian_version ? { obsidianVersion: r.obsidian_version } : {}),
    ...(r.obsidianTcApiVersion ? { apiVersion: r.obsidianTcApiVersion } : {}),
    ...(r.vault_path ? { vaultPath: r.vault_path } : {}),
  };
}

// A 404 (no route) or an explicit plugin_missing means the companion is absent;
// anything else (timeout, network, 5xx) is a transient unreachability.
function isMissing(e: unknown): boolean {
  if (!(e instanceof ObsidianTcError)) return false;
  if (e.code === "plugin_missing") return true;
  return e.details?.http_status === 404;
}

/** Probe the companion plugin. Never throws; returns a normalized snapshot. */
export async function probeCompanion(
  client: BridgeClient,
  opts: ProbeOptions = {},
): Promise<CapabilitySnapshot> {
  const timeoutMs = opts.timeoutMs ?? 500;
  const retryTimeoutMs = opts.retryTimeoutMs ?? 200;
  const attempt = async (t: number): Promise<CapabilitySnapshot> =>
    snapshotFrom(
      await client.request<ProbeResponseResult>({
        method: "GET",
        path: "/probe",
        timeoutMs: t,
        plugin: "obsidian-tc-companion",
      }),
    );

  try {
    return await attempt(timeoutMs);
  } catch (e) {
    if (isMissing(e)) return { companion: "missing", plugins: {} };
    try {
      return await attempt(retryTimeoutMs);
    } catch (e2) {
      if (isMissing(e2)) return { companion: "missing", plugins: {} };
      return { companion: "unreachable", plugins: {} };
    }
  }
}

export interface VaultCapabilityOptions extends ProbeOptions, PluginOverrides {
  /** Skip the probe entirely; force_enabled becomes the source of truth (G2.2 §6). */
  probeSkip?: boolean;
}

/**
 * Resolve a vault's capability snapshot: probe the companion (unless probe_skip,
 * or no client is configured) and apply config overrides. When probe_skip is set
 * the companion is treated reachable and force_enabled drives availability.
 */
export async function buildVaultCapabilities(
  client: BridgeClient | undefined,
  opts: VaultCapabilityOptions = {},
): Promise<CapabilitySnapshot> {
  if (opts.probeSkip || !client) {
    const base: CapabilitySnapshot = {
      companion: opts.probeSkip ? "reachable" : "missing",
      plugins: {},
    };
    return applyOverrides(base, opts);
  }
  const snap = await probeCompanion(client, opts);
  return applyOverrides(snap, opts);
}
