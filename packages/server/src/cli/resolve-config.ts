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

// The MCPB manifest spec (anthropics/dxt MANIFEST.md) never documents what a host substitutes
// for an optional `${user_config.X}` left blank in `mcp_config.args` -- observed against
// `@anthropic-ai/mcpb@2.1.2`'s `getMcpConfigForManifest`, a blank `config_path` leaves the
// LITERAL, unresolved placeholder text in argv (mcpb/manifest.json's own `config_path` stays
// `required: true` specifically because of this; this is defense in depth, not the primary
// fix, for any other manifest/host that substitutes an empty string instead). Either shape must
// be treated the same as "no argument was given" -- never as a real path to `statSync` -- and
// fall through to `OBSIDIAN_TC_CONFIG` exactly as an absent CLI argument would.
const UNSUBSTITUTED_PLACEHOLDER_RE = /^\$\{user_config\.[^}]+\}$/;

/** True for an empty string or an unresolved `${user_config.X}` placeholder -- both mean the
 *  host gave nothing usable, not a real vault/config path. */
function isUnusableInput(value: string): boolean {
  return value === "" || UNSUBSTITUTED_PLACEHOLDER_RE.test(value);
}

/** Normalizes a raw CLI/positional input: an empty string or unresolved MCPB placeholder becomes
 *  `undefined` (with one stderr line so this is visible, not a silent swallow), so the caller
 *  falls through to `OBSIDIAN_TC_CONFIG` instead of treating placeholder text as a path. Exported
 *  so every caller that derives its OWN `configPath` from the same raw input (cli.ts's
 *  `run_serve`, which passes it separately into `buildServerRuntime` for the module-loader trust
 *  root) normalizes through this one function rather than re-deriving the same check. */
export function normalizeConfigPathInput(input: string | undefined): string | undefined {
  if (input === undefined || !isUnusableInput(input)) return input;
  process.stderr.write(
    `obsidian-tc: ignoring unsubstituted MCPB placeholder or empty config path (${JSON.stringify(input)}); falling back to OBSIDIAN_TC_CONFIG.\n`,
  );
  return undefined;
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
  // `||`, not `??`: normalizeConfigPathInput already maps "" and an unresolved MCPB placeholder to
  // `undefined`, but `||` here is the second line of defense -- a defined-but-falsy `input` must
  // fall through to OBSIDIAN_TC_CONFIG rather than pin `target` to that falsy value and mask it
  // (the exact bug `??` had: `"" ?? env` returns "" because "" is not nullish).
  const target = normalizeConfigPathInput(input) || process.env.OBSIDIAN_TC_CONFIG;
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
