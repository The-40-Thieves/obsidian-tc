// Per-vault plugin-capability model (M4 / THE-180, G2.2 §6). A snapshot records
// whether the companion plugin answered (reachable / missing / unreachable) and,
// when reachable, which community plugins it reports installed. The snapshot is
// built once per vault at startup (probe.ts) and consulted by every bridge tool to
// decide degradation: companion missing or a plugin absent -> plugin_missing;
// companion unreachable -> plugin_unreachable. Config overrides
// (force_enabled/force_disabled) let CI and tests assert behavior deterministically
// without a live Obsidian.

/** THE-282: the companion API major this server speaks. Hand-mirrored with API_VERSION in
 *  packages/plugin/src/routes.ts (the plugin cannot import server code) — bump BOTH together. */
export const EXPECTED_COMPANION_API = "1";

export interface PluginCapability {
  installed: boolean;
  version?: string;
}

export type CompanionState = "reachable" | "missing" | "unreachable";

export interface CapabilitySnapshot {
  companion: CompanionState;
  plugins: Record<string, PluginCapability>;
  pluginVersion?: string;
  obsidianVersion?: string;
  apiVersion?: string;
  /** THE-282: probe apiVersion vs EXPECTED_COMPANION_API. Absent when the companion predates
   *  /probe versioning (treated as compatible — it answered the v1 probe shape). */
  apiCompat?: "compatible" | "incompatible";
  vaultPath?: string;
}

export interface PluginOverrides {
  forceEnabled?: string[];
  forceDisabled?: string[];
}

/**
 * Apply config overrides onto a probed snapshot. force_enabled marks a plugin
 * installed (preserving any probed version); force_disabled marks it missing.
 * Disabled wins when a name appears in both. Companion state is untouched —
 * overrides describe plugins, not the companion itself.
 */
export function applyOverrides(snap: CapabilitySnapshot, ov: PluginOverrides): CapabilitySnapshot {
  const plugins: Record<string, PluginCapability> = { ...snap.plugins };
  for (const p of ov.forceEnabled ?? []) {
    const existing = plugins[p];
    plugins[p] = existing ? { ...existing, installed: true } : { installed: true };
  }
  for (const p of ov.forceDisabled ?? []) {
    plugins[p] = { installed: false };
  }
  return { ...snap, plugins };
}

export type PluginStatus =
  | { kind: "available"; version?: string }
  | { kind: "plugin_missing"; reason: "companion_missing" | "plugin_not_installed" }
  | { kind: "plugin_unreachable" };

/**
 * Decide whether a bridge tool may call into `plugin` for this vault. Companion
 * unreachable short-circuits to plugin_unreachable; companion missing or the
 * plugin not installed degrades to plugin_missing.
 */
export function pluginStatus(snap: CapabilitySnapshot, plugin: string): PluginStatus {
  if (snap.companion === "unreachable") return { kind: "plugin_unreachable" };
  if (snap.companion === "missing") return { kind: "plugin_missing", reason: "companion_missing" };
  const cap = snap.plugins[plugin];
  if (cap?.installed)
    return cap.version ? { kind: "available", version: cap.version } : { kind: "available" };
  return { kind: "plugin_missing", reason: "plugin_not_installed" };
}

/** In-memory, per-session capability cache, built once per vault at startup. */
export class CapabilityCache {
  private readonly byVault = new Map<string, CapabilitySnapshot>();

  set(vaultId: string, snap: CapabilitySnapshot): void {
    this.byVault.set(vaultId, snap);
  }

  /** Unknown vault degrades as companion-missing (deny-by-default). */
  get(vaultId: string): CapabilitySnapshot {
    return this.byVault.get(vaultId) ?? { companion: "missing", plugins: {} };
  }

  has(vaultId: string): boolean {
    return this.byVault.has(vaultId);
  }
}
