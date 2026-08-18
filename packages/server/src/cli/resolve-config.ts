// Split out of args.ts (THE-636) to stay under biome's noExcessiveLinesPerFile floor — see
// args.ts's re-export comments. Config-target resolution (vault dir vs config file vs
// OBSIDIAN_TC_CONFIG) has no coupling to argv parsing; it depends only on CliError (moved to
// ./cli-error.ts for the same reason, breaking what would otherwise be a circular import back
// into args.ts).
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { finalizeConfig, isPlaneEnabledExplicit, readConfigFile } from "../config/load";
import { CliError } from "./cli-error";

/** Build a single-vault config from a vault directory, applying every schema default. */
export function configFromVaultPath(dir: string): ServerConfig {
  return finalizeConfig({ vaults: [{ id: "main", path: resolve(dir) }] });
}

/** THE-825: a resolved serve config paired with whether `plane.enabled` was set explicitly in the
 *  raw file (as opposed to being absent and defaulted) — see `resolveServeConfigWithProvenance`. */
export interface ResolvedServeConfig {
  config: ServerConfig;
  planeEnabledExplicit: boolean;
}

/**
 * Resolve a serve target, same rule as `resolveServeConfig` below, but also reports whether
 * `plane.enabled` was explicit in the raw file. Zero-config (a vault directory) has no file, so is
 * never explicit. The one substantive implementation — `resolveServeConfig` is a thin wrapper —
 * so the directory-vs-file resolution rule exists in exactly one place.
 */
export function resolveServeConfigWithProvenance(input?: string): ResolvedServeConfig {
  const target = input ?? process.env.OBSIDIAN_TC_CONFIG;
  if (!target) {
    throw new CliError(
      "no vault or config given: pass a vault folder or a config.json (or set OBSIDIAN_TC_CONFIG).",
    );
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(target);
  } catch {
    throw new CliError(`no such vault folder or config file: ${target}`);
  }
  if (stat.isDirectory()) {
    return { config: configFromVaultPath(target), planeEnabledExplicit: false };
  }
  const raw = readConfigFile(target);
  return { config: finalizeConfig(raw), planeEnabledExplicit: isPlaneEnabledExplicit(raw) };
}

/**
 * Resolve a serve target. A directory boots zero-config (a single vault "main");
 * a file is loaded as a config; absent falls back to OBSIDIAN_TC_CONFIG.
 */
export function resolveServeConfig(input?: string): ServerConfig {
  return resolveServeConfigWithProvenance(input).config;
}
