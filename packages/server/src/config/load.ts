import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";

/**
 * Apply environment-secret overlays (kept off disk) to a raw config object and
 * validate it against the schema. Shared by file loading and zero-config startup.
 */
export function finalizeConfig(raw: Record<string, unknown>): ServerConfig {
  const envSecret = process.env.OBSIDIAN_TC_JWT_SECRET;
  if (envSecret) {
    const auth = (raw.auth as Record<string, unknown> | undefined) ?? {};
    raw.auth = { ...auth, jwtSecret: envSecret };
  }
  // plur endpoint/token may come from the environment to keep the engram-store
  // bearer off disk (same pattern as the JWT secret). The token is only ever placed
  // in the Authorization header by the bridge transport, never logged.
  const plurEndpoint = process.env.OBSIDIAN_TC_PLUR_ENDPOINT;
  const plurToken = process.env.OBSIDIAN_TC_PLUR_TOKEN;
  if (plurEndpoint || plurToken) {
    const plur = (raw.plur as Record<string, unknown> | undefined) ?? {};
    raw.plur = {
      ...plur,
      ...(plurEndpoint ? { endpoint: plurEndpoint } : {}),
      ...(plurToken ? { apiKey: plurToken } : {}),
    };
  }
  const config = ServerConfigSchema.parse(raw);
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
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return finalizeConfig(raw);
}
