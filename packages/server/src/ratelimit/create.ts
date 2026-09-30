// Build the configured backend. Async because the sqlite adapter and the redis client are both
// imported lazily: a default (memory) boot loads neither.
import { readFileSync } from "node:fs";
import { err, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { RateLimitBackend } from "./backend";
import { MemoryBackend, type MemoryBackendOptions } from "./memory-backend";

export type ThrottleBackendConfig = Pick<ServerConfig["throttle"], "backend" | "redis">;

/** The schema defaults for `throttle.redis`, for callers that hold a config without the block. */
export const DEFAULT_REDIS_REF: ThrottleBackendConfig["redis"] = {
  urlEnv: "OBSIDIAN_TC_REDIS_URL",
  keyPrefix: "obsidian-tc:rl:",
};

/**
 * Resolve the Redis URL from its reference: `redis.urlFile` (a file holding the URL, the shape
 * container secrets take) wins over `redis.urlEnv` (the NAME of an environment variable). There is
 * deliberately no inline `url` — a connection URL carries the password, and config.json is echoed by
 * `config show` and read by admin tools. Refuses, naming the reference but never a value, when
 * nothing resolves.
 */
export function resolveRedisUrl(
  redis: ThrottleBackendConfig["redis"],
  env: Record<string, string | undefined> = process.env,
): string {
  if (redis.urlFile) {
    let raw: string;
    try {
      raw = readFileSync(redis.urlFile, "utf8");
    } catch (cause) {
      throw err.invalidInput(`throttle.redis.urlFile could not be read: ${redis.urlFile}`, {
        hint: (cause as NodeJS.ErrnoException).code ?? "read failed",
      });
    }
    const url = raw.trim();
    if (url) return url;
    throw err.invalidInput(`throttle.redis.urlFile is empty: ${redis.urlFile}`);
  }
  const url = env[redis.urlEnv]?.trim();
  if (url) return url;
  throw err.invalidInput(
    `throttle.backend is "redis" but ${redis.urlEnv} is not set and throttle.redis.urlFile is absent`,
    {
      hint: `export ${redis.urlEnv}=redis://[user:password@]host:6379 (or set throttle.redis.urlEnv / throttle.redis.urlFile), or use throttle.backend "memory" or "sqlite".`,
    },
  );
}

export interface CreateBackendContext {
  cacheDir: string;
  busyTimeoutMs: number;
  memory?: MemoryBackendOptions;
  env?: Record<string, string | undefined>;
}

export async function createRateLimitBackend(
  cfg: ThrottleBackendConfig,
  ctx: CreateBackendContext,
): Promise<RateLimitBackend> {
  switch (cfg.backend) {
    case "memory":
      return new MemoryBackend(ctx.memory);
    case "sqlite": {
      const { openSqliteBackend } = await import("./sqlite-backend");
      return openSqliteBackend({
        cacheDir: ctx.cacheDir,
        db: { busyTimeoutMs: ctx.busyTimeoutMs },
      });
    }
    case "redis": {
      const url = resolveRedisUrl(cfg.redis, ctx.env);
      const { RedisBackend } = await import("./redis-backend");
      return RedisBackend.create({ url, keyPrefix: cfg.redis.keyPrefix });
    }
  }
}
