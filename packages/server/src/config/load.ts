import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { applySecurityProfile } from "./security-profile";

/**
 * Apply environment-secret overlays (kept off disk) to a raw config object and
 * validate it against the schema. Shared by file loading and zero-config startup.
 */
/**
 * Overlay environment-supplied values onto a raw config object, in place.
 *
 * THE-518: exported and `env`-injectable because `config/explain.ts` must apply the EXACT same
 * overlay to attribute provenance. A second copy over there would be a hand-kept duplicate of a
 * hand-written list — the drift this repo keeps finding — so there is one implementation and
 * explain calls it.
 *
 * plur endpoint/token may come from the environment to keep the engram-store bearer off disk (same
 * pattern as the JWT secret). The token is only ever placed in the Authorization header by the
 * bridge transport, never logged.
 */
export function applyEnvOverlays(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const envSecret = env.OBSIDIAN_TC_JWT_SECRET;
  if (envSecret) {
    const auth = (raw.auth as Record<string, unknown> | undefined) ?? {};
    raw.auth = { ...auth, jwtSecret: envSecret };
  }
  const plurEndpoint = env.OBSIDIAN_TC_PLUR_ENDPOINT;
  const plurToken = env.OBSIDIAN_TC_PLUR_TOKEN;
  if (plurEndpoint || plurToken) {
    const plur = (raw.plur as Record<string, unknown> | undefined) ?? {};
    raw.plur = {
      ...plur,
      ...(plurEndpoint ? { endpoint: plurEndpoint } : {}),
      ...(plurToken ? { apiKey: plurToken } : {}),
    };
  }
  return raw;
}

/**
 * THE-825: whether `plane.enabled` was set explicitly in the RAW (pre-default, pre-validation)
 * config object, as opposed to being absent and defaulted by Zod's `.default(false)`. The two are
 * indistinguishable once `ServerConfigSchema.parse` has run -- an absent key and an explicit
 * `false` both resolve to `plane.enabled === false` -- so this must read the object BEFORE that
 * parse, the same raw object `finalizeConfig` is given. Neither the env overlay nor the security
 * profile touches `plane` (see applyEnvOverlays / security-profile.ts's HARDENED_BASE), so the raw
 * file object alone is the complete answer -- no precedence chain to resolve, unlike explain.ts.
 */
export function isPlaneEnabledExplicit(raw: Record<string, unknown>): boolean {
  const plane = raw.plane;
  return typeof plane === "object" && plane !== null && !Array.isArray(plane) && "enabled" in plane;
}

/** Parse a config file's raw JSON (BOM-stripped, THE-185), before any overlay or schema default
 *  is applied. Exported so a caller can inspect what the file itself said -- e.g.
 *  `isPlaneEnabledExplicit` -- without re-implementing this read. */
export function readConfigFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
}

export function finalizeConfig(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  applyEnvOverlays(raw, env);
  // THE-526: expand a named security profile into its field set BEFORE validation, so explicit fields
  // still override it and the result validates as a normal config.
  const config = ServerConfigSchema.parse(applySecurityProfile(raw));
  // The cacheDir default (".obsidian-tc") is relative, so cli.ts mkdir's it against the process
  // CWD, which breaks when a GUI launcher spawns the server in a non-writable directory: Claude
  // Desktop starts MCP servers in C:\WINDOWS\system32, so `mkdir .obsidian-tc` is EPERM at boot
  // (a terminal only worked because its CWD was the vault). Anchor a relative cacheDir to the
  // user's home so it is absolute and CWD-independent; the shared cache.db isolates vaults by
  // vault_id, so one machine-local dir is correct. An explicit absolute cacheDir is honored as-is.
  if (!isAbsolute(config.cacheDir)) config.cacheDir = join(homedir(), config.cacheDir);
  return config;
}

/**
 * Load and validate server config from a JSON file. The JWT secret may be
 * supplied via OBSIDIAN_TC_JWT_SECRET to keep it out of the file on disk.
 */
export function loadConfig(path: string): ServerConfig {
  return finalizeConfig(readConfigFile(path));
}
