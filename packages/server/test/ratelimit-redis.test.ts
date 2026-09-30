// Redis-specific behavior beyond the shared conformance suite. Real redis only (REDIS_URL).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { BucketSpec } from "../src/ratelimit/backend";
import { RedisBackend } from "../src/ratelimit/redis-backend";
import { REDIS_URL, redisExistenceFloor } from "./ratelimit-harness";

redisExistenceFloor();

const SPEC: BucketSpec = { capacity: 3, refillTokens: 10, intervalMs: 60_000 };

describe.skipIf(!REDIS_URL)("redis backend", () => {
  const open: RedisBackend[] = [];
  const prefix = () => `otc-test:${randomUUID()}:`;
  const make = async (keyPrefix = prefix()) => {
    const b = await RedisBackend.create({ url: REDIS_URL as string, keyPrefix });
    open.push(b);
    return b;
  };
  afterEach(async () => {
    await Promise.allSettled(open.splice(0).map((b) => b.close()));
  });

  async function raw() {
    const { createClient } = await import("@redis/client");
    const c = createClient({ url: REDIS_URL as string });
    await c.connect();
    return c;
  }

  it("heals after the server's script cache is flushed (EVALSHA -> EVAL fallback)", async () => {
    const b = await make();
    expect((await b.consume("k", SPEC, 1, 0)).ok).toBe(true);
    const c = await raw();
    try {
      await c.scriptFlush();
    } finally {
      c.destroy();
    }
    expect((await b.consume("k", SPEC, 1, 0)).tokens).toBe(1); // state kept, script re-sent
  });

  it("gives every bucket a TTL, so idle buckets are reclaimed by the server", async () => {
    const p = prefix();
    const b = await make(p);
    await b.consume("ttl", SPEC, 1, 0);
    const c = await raw();
    try {
      const ttl = await c.pTTL(`${p}ttl`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    } finally {
      c.destroy();
    }
  });

  it("keeps deployments apart by keyPrefix", async () => {
    const a = await make(prefix());
    const b = await make(prefix());
    for (let i = 0; i < 3; i++) await a.consume("k", SPEC, 1, 0);
    expect((await a.consume("k", SPEC, 1, 0)).ok).toBe(false);
    expect((await b.consume("k", SPEC, 1, 0)).ok).toBe(true);
  });

  it("rejects (never resolves a throttle) when the server is unreachable, and does so fast", async () => {
    const dead = await RedisBackend.create({
      url: "redis://user:hunter2@127.0.0.1:1", // nothing listens on port 1
      keyPrefix: prefix(),
      connectTimeoutMs: 300,
    });
    open.push(dead);
    const t0 = Date.now();
    const failure = await dead.consume("k", SPEC, 1, 0).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("rejects after close()", async () => {
    const b = await make();
    await b.close();
    await expect(b.consume("k", SPEC, 1, 0)).rejects.toThrow(/closed/);
  });
});
