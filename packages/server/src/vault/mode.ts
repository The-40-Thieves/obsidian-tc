// Per-vault live/headless mode resolution + the Tier-3 live guard (THE-255).
//
// Mode is not a write-path distinction (writes are always direct-atomic-fs, see backend.ts);
// it is solely whether the app-action channel (Local REST API) is reachable. Resolution is
// per-vault and resolved ONCE at startup: `auto` (or absent) probes bridge/probe.ts and the
// result is cached by the caller (cli.ts); explicit `live`/`headless` skip the probe.
import { err } from "@the-40-thieves/obsidian-tc-shared";

export type VaultMode = "live" | "headless";

export interface VaultModeConfig {
  mode?: "live" | "headless" | "auto";
  restApiUrl?: string;
}

/** Resolve a vault's mode. Explicit `live`/`headless` win; `auto` (or absent) is live only
 *  when a REST endpoint is configured AND the startup probe reached it (`restReachable`). */
export function resolveMode(cfg: VaultModeConfig, restReachable: boolean): VaultMode {
  if (cfg.mode === "live") return "live";
  if (cfg.mode === "headless") return "headless";
  return !!cfg.restApiUrl && restReachable ? "live" : "headless";
}

/** Guard for Tier-3 tools (action-firing app ops, app-computed reads). Throws the typed
 *  `requires_live_obsidian` when the vault is headless, so a client sees the reason rather
 *  than a silent failure. A no-op in live mode. */
export function assertLive(mode: VaultMode, tool?: string): void {
  if (mode !== "live") {
    throw err.requiresLiveObsidian(undefined, tool ? { tool } : undefined);
  }
}
