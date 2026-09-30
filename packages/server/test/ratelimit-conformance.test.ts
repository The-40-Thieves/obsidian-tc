// One conformance suite, three backends. Every backend must answer the same question identically:
// "refill this bucket to nowMs and try to take n tokens". The clock is injected, so nothing sleeps.
// The redis leg runs only against a REAL redis (REDIS_URL); see ratelimit-harness.ts for the loud
// skip and the CI existence floor.
import { afterEach, describe, expect, it } from "vitest";
import type { BucketSpec, RateLimitBackend } from "../src/ratelimit/backend";
import { TokenBucket } from "../src/ratelimit/bucket";
import { RateLimiter } from "../src/throttle";
import { redisExistenceFloor, STORE_KINDS, type Store } from "./ratelimit-harness";

redisExistenceFloor();

const SPEC: BucketSpec = { capacity: 3, refillTokens: 10, intervalMs: 60_000 };

/** Deterministic PRNG so the differential sequence is identical on every run and every backend. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const sk of STORE_KINDS) {
  describe.skipIf(!sk.enabled)(`rate-limit backend conformance: ${sk.kind}`, () => {
    const stores: Store[] = [];
    const fresh = async (): Promise<{ b: RateLimitBackend; store: Store }> => {
      const store = await sk.newStore();
      stores.push(store);
      return { b: await store.open(), store };
    };
    afterEach(async () => {
      await Promise.allSettled(stores.splice(0).map((s) => s.cleanup()));
    });

    it("starts full and drains the burst, then refuses", async () => {
      const { b } = await fresh();
      for (let i = 0; i < 3; i++) expect((await b.consume("k", SPEC, 1, 0)).ok).toBe(true);
      const fourth = await b.consume("k", SPEC, 1, 0);
      expect(fourth.ok).toBe(false);
      expect(fourth.tokens).toBe(0);
    });

    it("reports remaining tokens and the time until the next token", async () => {
      const { b } = await fresh();
      expect((await b.consume("k", SPEC, 1, 0)).tokens).toBe(2);
      await b.consume("k", SPEC, 1, 0);
      await b.consume("k", SPEC, 1, 0);
      const r = await b.consume("k", SPEC, 1, 0);
      expect(r.ok).toBe(false);
      expect(r.retryAfterMs).toBe(6_000); // 10 tokens / 60_000 ms = 1 token per 6_000 ms
    });

    it("refills continuously as the injected clock advances", async () => {
      const { b } = await fresh();
      for (let i = 0; i < 3; i++) await b.consume("k", SPEC, 1, 0);
      expect((await b.consume("k", SPEC, 1, 5_999)).ok).toBe(false);
      expect((await b.consume("k", SPEC, 1, 6_000)).ok).toBe(true);
      expect((await b.consume("k", SPEC, 1, 6_000)).ok).toBe(false);
    });

    it("caps refill at capacity after a long idle", async () => {
      const { b } = await fresh();
      for (let i = 0; i < 3; i++) await b.consume("k", SPEC, 1, 0);
      for (let i = 0; i < 3; i++) expect((await b.consume("k", SPEC, 1, 600_000)).ok).toBe(true);
      expect((await b.consume("k", SPEC, 1, 600_000)).ok).toBe(false);
    });

    it("takes n tokens at once and refuses an n the bucket cannot cover", async () => {
      const { b } = await fresh();
      expect((await b.consume("k", SPEC, 2, 0)).tokens).toBe(1);
      const r = await b.consume("k", SPEC, 2, 0);
      expect(r.ok).toBe(false);
      expect(r.tokens).toBe(1); // a refusal spends nothing
      expect((await b.consume("k", SPEC, 1, 0)).ok).toBe(true);
    });

    it("isolates buckets by key", async () => {
      const { b } = await fresh();
      for (let i = 0; i < 3; i++) await b.consume("a|read|v1", SPEC, 1, 0);
      expect((await b.consume("a|read|v1", SPEC, 1, 0)).ok).toBe(false);
      expect((await b.consume("a|read|v2", SPEC, 1, 0)).ok).toBe(true);
      expect((await b.consume("b|read|v1", SPEC, 1, 0)).ok).toBe(true);
    });

    it("never mints tokens from a clock that stands still or runs backwards", async () => {
      const { b } = await fresh();
      for (let i = 0; i < 3; i++) await b.consume("k", SPEC, 1, 100_000);
      expect((await b.consume("k", SPEC, 1, 100_000)).ok).toBe(false);
      expect((await b.consume("k", SPEC, 1, 0)).ok).toBe(false); // skewed-behind instance
      expect((await b.consume("k", SPEC, 1, 100_000)).ok).toBe(false); // and it did not rewind
    });

    it("is atomic under concurrency: N racing callers spend exactly `capacity` tokens", async () => {
      const store = await sk.newStore();
      stores.push(store);
      const handles = [await store.open(), await store.open()];
      const spec: BucketSpec = { capacity: 10, refillTokens: 10, intervalMs: 60_000 };
      const results = await Promise.all(
        Array.from({ length: 60 }, (_, i) => handles[i % 2]?.consume("k", spec, 1, 0)),
      );
      const granted = results.filter((r) => r?.ok).length;
      // Two independent memory handles are two independent limiters (documented), so each grants 10.
      expect(granted).toBe(sk.shared ? 10 : 20);
    });

    it("matches the reference TokenBucket on a long randomized schedule (differential)", async () => {
      const { b } = await fresh();
      const spec: BucketSpec = { capacity: 5, refillTokens: 7, intervalMs: 60_000 };
      const ref = new TokenBucket(spec);
      const rnd = mulberry32(0xc0ffee);
      const dts = [0, 0, 1, 250, 1_000, 6_000, 20_000, -300];
      const ns = [1, 1, 1, 2, 4];
      let now = 1_000_000;
      for (let i = 0; i < 400; i++) {
        now += dts[Math.floor(rnd() * dts.length)] as number;
        const n = ns[Math.floor(rnd() * ns.length)] as number;
        const want = ref.tryRemove(n, now);
        const got = await b.consume("diff", spec, n, now);
        expect(got, `step ${i} (n=${n}, now=${now})`).toEqual(want);
      }
    });

    it("drives a RateLimiter end to end with the same G2.4 decision fields", async () => {
      const store = await sk.newStore();
      stores.push(store);
      const limiter = new RateLimiter(
        { bulk: { perMinute: 10, burst: 3 } },
        { backend: await store.open() },
      );
      for (let i = 0; i < 3; i++)
        expect((await limiter.check("c0ffee00", "bulk", "v1", 0)).ok).toBe(true);
      const d = await limiter.check("c0ffee00", "bulk", "v1", 0);
      expect(d).toMatchObject({
        ok: false,
        scopeClass: "bulk",
        retryAfterSeconds: 6,
        currentRate: 10,
        currentBurst: 0,
      });
      expect(limiter.snapshot()).toEqual([{ vault: "v1", scope_class: "bulk", hits: 1 }]);
    });
  });
}
