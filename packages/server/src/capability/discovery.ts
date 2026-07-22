// THE-522 — Obsidian discovery: registry, config-dir resolution, plugin scan.
//
// Everything here parses de-facto structure written by the desktop app or third parties, so every
// reader degrades rather than throws: an absent registry is the supported "no Obsidian" state, a
// junk manifest is bucketed as unreadable, a missing config dir yields null.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { type PluginManifest, parseManifest } from "./manifest";

/** A vault as the desktop app records it. `name` is derived (the registry has no name field). */
export interface RegistryVault {
  id: string;
  path: string;
  name: string;
  open: boolean;
}

// The registry value is an opaque-id -> { path, ts?, open? } map. We validate only what we read and
// ignore unknown siblings (e.g. the top-level `cli` flag) so a schema drift never fails the parse.
const RegistrySchema = z.object({
  vaults: z
    .record(
      z.string(),
      z.object({ path: z.string().optional(), open: z.boolean().optional() }).passthrough(),
    )
    .optional(),
});

/**
 * Parse an obsidian.json registry into vaults. Returns [] for any shape that carries no usable
 * vault — an absent/empty registry is the first-class "no Obsidian installed" state, not an error.
 * Entries without a `path` are skipped rather than emitted broken.
 */
export function parseRegistry(raw: string): RegistryVault[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = RegistrySchema.safeParse(json);
  if (!parsed.success || !parsed.data.vaults) return [];

  const out: RegistryVault[] = [];
  for (const [id, entry] of Object.entries(parsed.data.vaults)) {
    if (!entry.path) continue; // no path -> unusable, drop it
    out.push({ id, path: entry.path, name: basename(entry.path), open: entry.open ?? false });
  }
  return out;
}

export interface ConfigDirResult {
  /** Directory name (e.g. ".obsidian" or an override like ".obsidian-awesome"). */
  name: string;
  /** Absolute path to the config directory. */
  path: string;
  /** True when the name is anything other than the default ".obsidian". */
  overridden: boolean;
}

const DEFAULT_CONFIG_DIR = ".obsidian";
// A directory is an Obsidian config dir if it carries one of these. app.json is written on first
// open; community-plugins.json appears once a community plugin is enabled. Either is a reliable marker.
const CONFIG_MARKERS = ["app.json", "community-plugins.json"];

function looksLikeConfigDir(dir: string): boolean {
  return CONFIG_MARKERS.some((m) => existsSync(join(dir, m)));
}

/**
 * Resolve a vault's config directory. Order: an explicit `override`, then the default `.obsidian`,
 * then a scan for any dot-directory carrying a config marker (the folder name is user-overridable
 * and NOT derivable from the vault name). Returns null when the vault has no config dir — a valid
 * state for a plain folder that was never opened in Obsidian.
 */
export function resolveConfigDir(vaultPath: string, override?: string): ConfigDirResult | null {
  if (override) {
    const p = join(vaultPath, override);
    if (existsSync(p))
      return { name: override, path: p, overridden: override !== DEFAULT_CONFIG_DIR };
    return null;
  }

  const dflt = join(vaultPath, DEFAULT_CONFIG_DIR);
  if (existsSync(dflt) && looksLikeConfigDir(dflt)) {
    return { name: DEFAULT_CONFIG_DIR, path: dflt, overridden: false };
  }

  // Scan for an overridden config folder: a dot-directory carrying a marker file.
  let entries: string[];
  try {
    entries = readdirSync(vaultPath);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.startsWith(".")) continue;
    const p = join(vaultPath, name);
    try {
      if (statSync(p).isDirectory() && looksLikeConfigDir(p)) {
        return { name, path: p, overridden: name !== DEFAULT_CONFIG_DIR };
      }
    } catch {
      // unreadable entry — skip it
    }
  }
  return null;
}

/** A plugin manifest plus its enabled-state (which lives in community-plugins.json, not the manifest). */
export interface DiscoveredPlugin extends PluginManifest {
  enabled: boolean;
}

export interface PluginDiscovery {
  installed: DiscoveredPlugin[];
  unreadable: { folder: string; reason: string }[];
  /** True when a config dir was found; distinguishes "no plugins" from "not a vault". */
  configDir: ConfigDirResult | null;
}

function readEnabledSet(configDirPath: string): Set<string> {
  try {
    const raw = readFileSync(join(configDirPath, "community-plugins.json"), "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    // absent or malformed -> nothing is enabled
  }
  return new Set();
}

/**
 * Discover installed plugins for a vault. Reads every `<configDir>/plugins/<folder>/manifest.json`,
 * parses each defensively, and marks enabled-state from community-plugins.json. A single bad
 * manifest lands in `unreadable` rather than aborting the scan.
 */
export function discoverPlugins(vaultPath: string, override?: string): PluginDiscovery {
  const configDir = resolveConfigDir(vaultPath, override);
  const empty: PluginDiscovery = { installed: [], unreadable: [], configDir };
  if (!configDir) return empty;

  const pluginsRoot = join(configDir.path, "plugins");
  if (!existsSync(pluginsRoot)) return empty;

  const enabled = readEnabledSet(configDir.path);
  const installed: DiscoveredPlugin[] = [];
  const unreadable: { folder: string; reason: string }[] = [];

  let folders: string[];
  try {
    folders = readdirSync(pluginsRoot);
  } catch {
    return empty;
  }

  for (const folder of folders) {
    const manifestPath = join(pluginsRoot, folder, "manifest.json");
    let raw: string;
    try {
      if (!statSync(join(pluginsRoot, folder)).isDirectory()) continue;
      raw = readFileSync(manifestPath, "utf8");
    } catch {
      continue; // no manifest in this folder — not a plugin dir, skip silently
    }
    const result = parseManifest(folder, raw);
    if (result.ok) {
      installed.push({ ...result.plugin, enabled: enabled.has(result.plugin.id) });
    } else {
      unreadable.push({ folder: result.folder, reason: result.reason });
    }
  }

  installed.sort((a, b) => a.id.localeCompare(b.id));
  return { installed, unreadable, configDir };
}
