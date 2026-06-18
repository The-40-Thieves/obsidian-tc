import { readFileSync } from "node:fs";
import { type ServerConfig, ServerConfigSchema } from "@obsidian-tc/shared";

/**
 * Load and validate server config from a JSON file. The JWT secret may be
 * supplied via OBSIDIAN_TC_JWT_SECRET to keep it out of the file on disk.
 */
export function loadConfig(path: string): ServerConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
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
  return ServerConfigSchema.parse(raw);
}
