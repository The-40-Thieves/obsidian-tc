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
  return ServerConfigSchema.parse(raw);
}
