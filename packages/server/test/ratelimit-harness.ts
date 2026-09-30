// Shared fixtures for the rate-limit backend suites: a store per backend kind that can open several
// independent handles onto ONE underlying bucket store (what "two processes/instances" means).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, it } from "vitest";
import type { RateLimitBackend, RateLimitBackendKind } from "../src/ratelimit/backend";
import { MemoryBackend } from "../src/ratelimit/memory-backend";
import { openSqliteBackend } from "../src/ratelimit/sqlite-backend";

export const REDIS_URL = process.env.REDIS_URL;
/** CI sets REQUIRE_REDIS=1 so a missing service fails the suite instead of skipping it. */
export const REQUIRE_REDIS = process.env.REQUIRE_REDIS === "1";

if (!REDIS_URL) {
  // Loud on purpose: a silently skipped redis suite reads as green while covering nothing.
  console.warn(
    "[ratelimit] SKIPPING the redis backend suites: REDIS_URL is not set. Start one with " +
      "`docker run --rm -d -p 127.0.0.1:6379:6379 redis:8.10.2-alpine` and run with " +
      "REDIS_URL=redis://127.0.0.1:6379 (CI sets REQUIRE_REDIS=1, which fails instead of skipping).",
  );
}

/** Register the existence floor: with REQUIRE_REDIS=1 and no REDIS_URL this file FAILS. */
export function redisExistenceFloor(): void {
  if (REQUIRE_REDIS && !REDIS_URL) {
    it("REQUIRE_REDIS=1 needs REDIS_URL (the redis suites must not skip in CI)", () => {
      throw new Error(
        "REQUIRE_REDIS=1 but REDIS_URL is not set — refusing to skip the redis suites",
      );
    });
  }
}

export interface Store {
  /** A NEW handle onto the same underlying store (a fresh connection, like another process). */
  open(): Promise<RateLimitBackend>;
  cleanup(): Promise<void>;
}

const BUSY_TIMEOUT_MS = 5000;

export interface StoreKind {
  kind: RateLimitBackendKind;
  /** false for memory: independent handles do NOT see each other, by design. */
  shared: boolean;
  /** false for memory: a "restart" (new handle) starts from full buckets, by design. */
  durable: boolean;
  enabled: boolean;
  newStore(): Promise<Store>;
}

const opened: RateLimitBackend[] = [];
afterAll(async () => {
  await Promise.allSettled(opened.map((b) => b.close()));
});

export const STORE_KINDS: StoreKind[] = [
  {
    kind: "memory",
    shared: false,
    durable: false,
    enabled: true,
    async newStore() {
      return {
        async open() {
          const b = new MemoryBackend();
          opened.push(b);
          return b;
        },
        async cleanup() {},
      };
    },
  },
  {
    kind: "sqlite",
    shared: true,
    durable: true,
    enabled: true,
    async newStore() {
      const cacheDir = mkdtempSync(join(tmpdir(), "otc-ratelimit-"));
      return {
        async open() {
          const b = await openSqliteBackend({ cacheDir, db: { busyTimeoutMs: BUSY_TIMEOUT_MS } });
          opened.push(b);
          return b;
        },
        async cleanup() {
          rmSync(cacheDir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    kind: "redis",
    shared: true,
    durable: true,
    enabled: Boolean(REDIS_URL),
    async newStore() {
      const { RedisBackend } = await import("../src/ratelimit/redis-backend");
      const keyPrefix = `otc-test:${randomUUID()}:`;
      return {
        async open() {
          const b = await RedisBackend.create({ url: REDIS_URL as string, keyPrefix });
          opened.push(b);
          return b;
        },
        async cleanup() {
          const { createClient } = await import("@redis/client");
          const c = createClient({ url: REDIS_URL as string });
          await c.connect();
          try {
            for await (const keys of c.scanIterator({ MATCH: `${keyPrefix}*`, COUNT: 100 })) {
              if (keys.length) await c.del(keys);
            }
          } finally {
            c.destroy();
          }
        },
      };
    },
  },
];
