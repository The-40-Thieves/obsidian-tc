// THE-522 — the top-level capability profile.
//
// The typed artifact that doctor (THE-521), install presets (THE-509) and CI consume. It assembles,
// from the machine as it actually is: the Obsidian registry and its vaults, each vault's installed +
// enabled plugins, the runtime, and the hardware envelope. Every input degrades — a missing registry
// is the supported no-Obsidian state, a junk manifest is bucketed, hardware enrichment is best-effort.
//
// Inputs are injected (registry path, explicit vault paths, hardware enricher) so the assembler is
// testable off a real install and so the CLI can pass an explicit --config-dir / added vaults.
import { existsSync, readFileSync } from "node:fs";
import { version as SERVER_VERSION } from "../../package.json";
import { nativeLoaded } from "../search/native";
import { discoverPlugins, type PluginDiscovery, parseRegistry } from "./discovery";
import { type HardwareEnrichment, type HardwareEnvelope, hardwareEnvelope } from "./hardware";
import { locateRegistry } from "./locate";

export interface VaultProfile {
  id: string;
  path: string;
  name: string;
  open: boolean;
  /** How the vault was found: read from the registry, or supplied explicitly (add-vault). */
  source: "registry" | "explicit";
  configDir: PluginDiscovery["configDir"];
  plugins: { installed: PluginDiscovery["installed"]; unreadable: PluginDiscovery["unreadable"] };
}

export interface RuntimeProfile {
  name: "bun" | "node";
  version: string;
  /** True when the compiled native acceleration module is loaded. */
  nativeModule: boolean;
}

export interface CapabilityProfile {
  serverVersion: string;
  runtime: RuntimeProfile;
  obsidian: {
    /** Absolute path to the located obsidian.json, or null when none was found. */
    registryPath: string | null;
    /** True only when a registry existed and was read — the desktop app has run here. */
    installed: boolean;
    vaults: VaultProfile[];
  };
  hardware: HardwareEnvelope;
}

export interface ResolveOptions {
  /** Explicit obsidian.json path. Omitted -> auto-locate for this platform. */
  registryPath?: string;
  /** Extra vault paths to include regardless of the registry (the add-vault escape hatch). */
  extraVaultPaths?: string[];
  /** Per-vault config-dir override name (e.g. ".obsidian-awesome"), applied to every scanned vault. */
  configDirOverride?: string;
  /** Injected hardware enricher, for tests. Defaults to the systeminformation reader. */
  enrich?: () => Promise<HardwareEnrichment>;
}

function detectRuntime(): RuntimeProfile {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return {
    name: isBun ? "bun" : "node",
    version: isBun
      ? ((globalThis as { Bun?: { version: string } }).Bun?.version ?? "unknown")
      : process.versions.node,
    nativeModule: nativeLoaded,
  };
}

function discoverVault(
  path: string,
  meta: { id: string; name: string; open: boolean; source: "registry" | "explicit" },
  override?: string,
): VaultProfile {
  const { installed, unreadable, configDir } = discoverPlugins(path, override);
  return {
    id: meta.id,
    path,
    name: meta.name,
    open: meta.open,
    source: meta.source,
    configDir,
    plugins: { installed, unreadable },
  };
}

/**
 * Read the machine into a typed capability profile. Merges registry vaults with explicit add-vault
 * paths (registry wins on a path collision), resolves each vault's config dir and plugins, and folds
 * in runtime + hardware. Never throws on a missing/partial environment.
 */
export async function resolveCapabilityProfile(
  opts: ResolveOptions = {},
): Promise<CapabilityProfile> {
  const registryPath = opts.registryPath ?? locateRegistry();
  const haveRegistry = Boolean(registryPath && existsSync(registryPath));

  const registryVaults = haveRegistry ? parseRegistry(safeRead(registryPath as string)) : [];

  const seen = new Set(registryVaults.map((v) => v.path));
  const vaults: VaultProfile[] = registryVaults.map((v) =>
    discoverVault(
      v.path,
      { id: v.id, name: v.name, open: v.open, source: "registry" },
      opts.configDirOverride,
    ),
  );

  for (const path of opts.extraVaultPaths ?? []) {
    if (seen.has(path)) continue; // registry entry already covers it
    seen.add(path);
    vaults.push(
      discoverVault(
        path,
        { id: basenameId(path), name: basenameOf(path), open: false, source: "explicit" },
        opts.configDirOverride,
      ),
    );
  }

  const hardware = await hardwareEnvelope(opts.enrich);

  return {
    serverVersion: SERVER_VERSION,
    runtime: detectRuntime(),
    obsidian: {
      registryPath: haveRegistry ? (registryPath as string) : null,
      installed: haveRegistry,
      vaults,
    },
    hardware,
  };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "{}";
  }
}

function basenameOf(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// An explicit vault has no registry id; derive a stable one from its basename so profiles are diffable.
function basenameId(p: string): string {
  return basenameOf(p);
}
