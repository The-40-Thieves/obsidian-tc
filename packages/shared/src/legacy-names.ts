// The project was renamed from obsidian-tc to reliquary-tc in 2.0.0. Every identifier a user,
// client or operator may already depend on keeps working under its old spelling through the
// 2.x line, with the new spelling winning when both are present. This module is the single list
// of those pairs; scripts/rename-mapping.test.mjs fails if the old name appears anywhere else.
import { join } from "node:path";

export const CURRENT_NAMES = {
  /** npm package and CLI command. */
  bin: "reliquary-tc",
  /** Environment variable prefix. */
  envPrefix: "RELIQUARY_TC_",
  /** MCP resource URI scheme (`<scheme>://<vault>/<path>`). */
  resourceScheme: "reliquary-tc",
  /** Prometheus metric name prefix. */
  metricPrefix: "reliquary_tc_",
  /** Per-user folder under the home directory (config.json, cache). */
  homeDirName: ".reliquary-tc",
  /** Client-supplied `_meta` key carrying self-reported provenance. */
  provenanceMetaKey: "io.reliquary-tc/provenance",
  /** Resource-subscription key clients use for security advisories. */
  advisorySubscriptionKey: "io.the40thieves.reliquary-tc/advisory",
} as const;

export const LEGACY_NAMES = {
  bin: "obsidian-tc",
  envPrefix: "OBSIDIAN_TC_",
  resourceScheme: "obsidian-tc",
  metricPrefix: "obsidian_tc_",
  homeDirName: ".obsidian-tc",
  provenanceMetaKey: "io.obsidian-tc/provenance",
  advisorySubscriptionKey: "io.the40thieves.obsidian-tc/advisory",
} as const satisfies Record<keyof typeof CURRENT_NAMES, string>;

export type RenamedIdentifier = keyof typeof CURRENT_NAMES;

/**
 * Copy every `OBSIDIAN_TC_*` variable to its `RELIQUARY_TC_*` name when the new name is unset.
 * A set new name always wins, including an explicit empty string. Mutates `env` in place so
 * child processes inherit the result, and returns the old names that were copied, for a single
 * deprecation warning. Call it before any module reads configuration from the environment.
 */
export function applyLegacyEnvAliases(env: Record<string, string | undefined>): string[] {
  const aliased: string[] = [];
  const legacy = LEGACY_NAMES.envPrefix;
  for (const key of Object.keys(env)) {
    if (!key.startsWith(legacy) || key.length === legacy.length) continue;
    const value = env[key];
    if (value === undefined) continue;
    const next = CURRENT_NAMES.envPrefix + key.slice(legacy.length);
    if (env[next] !== undefined) continue;
    env[next] = value;
    aliased.push(key);
  }
  return aliased;
}

/** Strip either resource scheme from a URI. Returns null for any other scheme. */
export function matchResourceScheme(uri: string): { rest: string; legacy: boolean } | null {
  for (const [scheme, legacy] of [
    [CURRENT_NAMES.resourceScheme, false],
    [LEGACY_NAMES.resourceScheme, true],
  ] as const) {
    const prefix = `${scheme}://`;
    if (uri.startsWith(prefix)) return { rest: uri.slice(prefix.length), legacy };
  }
  return null;
}

/**
 * The per-user folder under `home`. A fresh install and any install that already has the new
 * folder use it; an install that only has the old folder keeps using that one. Nothing is moved.
 */
export function pickHomeDir(
  home: string,
  exists: (path: string) => boolean,
): { dir: string; legacy: boolean } {
  const current = join(home, CURRENT_NAMES.homeDirName);
  if (exists(current)) return { dir: current, legacy: false };
  const legacy = join(home, LEGACY_NAMES.homeDirName);
  if (exists(legacy)) return { dir: legacy, legacy: true };
  return { dir: current, legacy: false };
}

/** Read a renamed `_meta` key, preferring the current spelling. */
export function readMetaKey(
  meta: Readonly<Record<string, unknown>> | undefined,
  key: "provenanceMetaKey",
): unknown {
  if (!meta) return undefined;
  if (CURRENT_NAMES[key] in meta) return meta[CURRENT_NAMES[key]];
  return meta[LEGACY_NAMES[key]];
}
