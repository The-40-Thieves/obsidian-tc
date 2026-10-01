// Config surface and zero-config guarantees for the rate-limit backends.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactConfig } from "../src/cli/redact-config";
import {
  createRateLimitBackend,
  DEFAULT_REDIS_REF,
  resolveRedisUrl,
} from "../src/ratelimit/create";
import { MemoryBackend } from "../src/ratelimit/memory-backend";
import { makeTempDir } from "./tmp";

const base = { vaults: [{ id: "v", path: "/tmp/v" }], cacheDir: "/tmp/c" };

describe("throttle config", () => {
  it("defaults to the memory backend, fail-open, and a redis reference that holds no secret", () => {
    const c = ServerConfigSchema.parse(base);
    expect(c.throttle.backend).toBe("memory");
    expect(c.throttle.failurePolicy).toBe("fail-open");
    expect(c.throttle.redis).toEqual({
      urlEnv: "OBSIDIAN_TC_REDIS_URL",
      keyPrefix: "obsidian-tc:rl:",
    });
    expect(DEFAULT_REDIS_REF).toEqual(c.throttle.redis);
  });

  it("accepts each backend and both policies, and rejects anything else", () => {
    for (const backend of ["memory", "sqlite", "redis"]) {
      for (const failurePolicy of ["fail-open", "fail-closed"]) {
        expect(
          ServerConfigSchema.parse({ ...base, throttle: { backend, failurePolicy } }).throttle,
        ).toMatchObject({ backend, failurePolicy });
      }
    }
    expect(() => ServerConfigSchema.parse({ ...base, throttle: { backend: "etcd" } })).toThrow();
    expect(() =>
      ServerConfigSchema.parse({ ...base, throttle: { failurePolicy: "open" } }),
    ).toThrow();
  });

  it("has no inline URL field: the password can only come from env or a file", () => {
    const redis = ServerConfigSchema.parse(base).throttle.redis;
    expect(Object.keys(redis).sort()).toEqual(["keyPrefix", "urlEnv"]);
    // and `config show` therefore has nothing to redact in the block
    expect(JSON.stringify(redactConfig(ServerConfigSchema.parse(base).throttle))).not.toContain(
      "<redacted>",
    );
  });
});

describe("resolveRedisUrl", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ref = { urlEnv: "MY_REDIS", keyPrefix: "p:" };

  it("reads the env var NAMED by urlEnv", () => {
    expect(resolveRedisUrl(ref, { MY_REDIS: " redis://u:p@h:6379 " })).toBe("redis://u:p@h:6379");
  });

  it("reads urlFile, and urlFile wins over urlEnv", () => {
    const d = makeTempDir("otc-redisurl-");
    dirs.push(d);
    const f = join(d, "url");
    writeFileSync(f, "redis://from-file:6379\n");
    expect(resolveRedisUrl({ ...ref, urlFile: f }, { MY_REDIS: "redis://from-env:6379" })).toBe(
      "redis://from-file:6379",
    );
  });

  it("refuses with the reference's NAME, never a value, when nothing resolves", () => {
    let message = "";
    try {
      resolveRedisUrl(ref, {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("MY_REDIS");
    expect(message).toContain("redis");
  });

  it("refuses an unreadable or empty urlFile without echoing its content", () => {
    const d = makeTempDir("otc-redisurl-");
    dirs.push(d);
    expect(() => resolveRedisUrl({ ...ref, urlFile: join(d, "missing") }, {})).toThrow(/urlFile/);
    const f = join(d, "empty");
    writeFileSync(f, "  \n");
    expect(() => resolveRedisUrl({ ...ref, urlFile: f }, {})).toThrow(/empty/);
  });
});

describe("zero-config stays zero-cost", () => {
  it("the default backend is the process-local memory map", async () => {
    const b = await createRateLimitBackend(
      { backend: "memory", redis: DEFAULT_REDIS_REF },
      { cacheDir: "/nonexistent", busyTimeoutMs: 5000 },
    );
    expect(b).toBeInstanceOf(MemoryBackend);
  });

  it("no module outside redis-backend.ts names the redis client, and there it is only import()ed", () => {
    const srcRoot = new URL("../src/", import.meta.url);
    const files = [
      "throttle.ts",
      "ratelimit/backend.ts",
      "ratelimit/bucket.ts",
      "ratelimit/create.ts",
      "ratelimit/memory-backend.ts",
      "ratelimit/sqlite-backend.ts",
      "ratelimit/outage-hooks.ts",
      "runtime/governance.ts",
      "runtime/runtime-core-wiring.ts",
    ];
    for (const f of files) {
      expect(readFileSync(new URL(f, srcRoot), "utf8"), f).not.toMatch(
        /(from\s+|import\(\s*)["']@redis\/client["']/,
      );
    }
    const redisSrc = readFileSync(new URL("ratelimit/redis-backend.ts", srcRoot), "utf8");
    expect(redisSrc).not.toMatch(/^import[^;]*from\s+["']@redis\/client["']/m);
    expect(redisSrc).toContain('import("@redis/client")');
    // and create.ts reaches the redis/sqlite modules only through dynamic import
    const create = readFileSync(new URL("ratelimit/create.ts", srcRoot), "utf8");
    expect(create).not.toMatch(/^import[^;]*from\s+["']\.\/(redis|sqlite)-backend["']/m);
  });

  it("the build keeps the optional client out of the bundle", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
      optionalDependencies: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain("--external @redis/client");
    expect(pkg.optionalDependencies["@redis/client"]).toMatch(/^\d+\.\d+\.\d+$/); // exact pin
  });
});

describe("a missing optional client refuses at creation with the remedy", () => {
  it("names the package and the fallback backends", async () => {
    vi.resetModules();
    vi.doMock("@redis/client", () => {
      throw Object.assign(new Error("Cannot find package '@redis/client'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });
    const { RedisBackend } = await import("../src/ratelimit/redis-backend");
    await expect(
      RedisBackend.create({ url: "redis://u:p@h:6379", keyPrefix: "x:" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("@redis/client"),
    });
    vi.doUnmock("@redis/client");
    vi.resetModules();
  });
});
