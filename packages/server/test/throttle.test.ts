// Unit tests for the deterministic token-bucket throttle (THE-182, G2.4 §Rate
// limits). The clock is injected as an explicit `nowMs` argument — no wall-clock
// sleeps — so refill, burst, and exhaustion are asserted deterministically.
import { describe, expect, it } from "vitest";
import { DEFAULT_THROTTLE_TIERS, RateLimiter, TokenBucket, callerHash } from "../src/throttle";

describe("TokenBucket", () => {
  it("starts full at capacity and drains the burst", () => {
    const b = new TokenBucket({ capacity: 3, refillTokens: 10, intervalMs: 60_000 });
    expect(b.tryRemove(1, 0).ok).toBe(true);
    expect(b.tryRemove(1, 0).ok).toBe(true);
    expect(b.tryRemove(1, 0).ok).toBe(true);
    const fourth = b.tryRemove(1, 0);
    expect(fourth.ok).toBe(false);
    expect(fourth.tokens).toBe(0);
  });

  it("reports the time until the next token when exhausted", () => {
    const b = new TokenBucket({ capacity: 3, refillTokens: 10, intervalMs: 60_000 });
    for (let i = 0; i < 3; i++) b.tryRemove(1, 0);
    // rate = 10 tokens / 60_000 ms = 1 token per 6_000 ms.
    const r = b.tryRemove(1, 0);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(6_000);
  });

  it("refills continuously as the injected clock advances", () => {
    const b = new TokenBucket({ capacity: 3, refillTokens: 10, intervalMs: 60_000 });
    for (let i = 0; i < 3; i++) b.tryRemove(1, 0);
    expect(b.tryRemove(1, 5_999).ok).toBe(false); // not quite one token yet
    expect(b.tryRemove(1, 6_000).ok).toBe(true); // exactly one token refilled
    expect(b.tryRemove(1, 6_000).ok).toBe(false); // and immediately spent
  });

  it("caps refill at capacity after a long idle", () => {
    const b = new TokenBucket({ capacity: 3, refillTokens: 10, intervalMs: 60_000 });
    for (let i = 0; i < 3; i++) b.tryRemove(1, 0);
    // 10 minutes idle would refill 100 tokens, but the cap is 3.
    expect(b.tryRemove(1, 600_000).ok).toBe(true);
    expect(b.tryRemove(1, 600_000).ok).toBe(true);
    expect(b.tryRemove(1, 600_000).ok).toBe(true);
    expect(b.tryRemove(1, 600_000).ok).toBe(false);
  });

  it("honors a custom initial token count", () => {
    const b = new TokenBucket({
      capacity: 5,
      refillTokens: 10,
      intervalMs: 60_000,
      initialTokens: 0,
    });
    expect(b.tryRemove(1, 0).ok).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("enforces the bulk tier: 3 burst then throttled with G2.4 detail fields", () => {
    const rl = new RateLimiter(DEFAULT_THROTTLE_TIERS);
    for (let i = 0; i < 3; i++) {
      expect(rl.check("c0ffee00", "bulk", "v1", 0).ok).toBe(true);
    }
    const d = rl.check("c0ffee00", "bulk", "v1", 0);
    expect(d.ok).toBe(false);
    expect(d.scopeClass).toBe("bulk");
    expect(d.retryAfterSeconds).toBe(6);
    expect(d.currentRate).toBe(10);
    expect(d.currentBurst).toBe(0);
  });

  it("enforces the delete tier: 20 burst then throttled (THE-212)", () => {
    const rl = new RateLimiter(DEFAULT_THROTTLE_TIERS);
    for (let i = 0; i < 20; i++) {
      expect(rl.check("deadbeef", "delete", "v1", 0).ok).toBe(true);
    }
    const d = rl.check("deadbeef", "delete", "v1", 0);
    expect(d.ok).toBe(false);
    expect(d.scopeClass).toBe("delete");
    expect(d.currentRate).toBe(60);
    expect(d.currentBurst).toBe(0);
  });

  it("keys buckets independently by (caller, scope_class, vault)", () => {
    const rl = new RateLimiter(DEFAULT_THROTTLE_TIERS);
    for (let i = 0; i < 3; i++) rl.check("cafe", "bulk", "v1", 0);
    // a different vault, caller, or scope class is a fresh bucket
    expect(rl.check("cafe", "bulk", "v2", 0).ok).toBe(true);
    expect(rl.check("beef", "bulk", "v1", 0).ok).toBe(true);
    expect(rl.check("cafe", "write", "v1", 0).ok).toBe(true);
  });

  it("treats an unknown scope class as unlimited", () => {
    const rl = new RateLimiter(DEFAULT_THROTTLE_TIERS);
    for (let i = 0; i < 1000; i++) {
      expect(rl.check("cafe", "mystery", "v1", 0).ok).toBe(true);
    }
  });

  it("counts throttle hits per (vault, scope_class) for the metrics snapshot", () => {
    const rl = new RateLimiter(DEFAULT_THROTTLE_TIERS);
    for (let i = 0; i < 5; i++) rl.check("cafe", "bulk", "v1", 0); // 3 ok, 2 throttled
    const snap = rl.snapshot();
    const row = snap.find((s) => s.vault === "v1" && s.scope_class === "bulk");
    expect(row?.hits).toBe(2);
  });
});

describe("RateLimiter bucket eviction (THE-213)", () => {
  it("drops buckets idle past the TTL on the next sweep", () => {
    const rl = new RateLimiter(DEFAULT_THROTTLE_TIERS, {
      idleTtlMs: 1_000,
      sweepIntervalMs: 100,
      maxBuckets: 10_000,
    });
    rl.check("a", "read", "v1", 0); // bucket A; first sweep sets lastSweep=0
    rl.check("b", "read", "v1", 0); // bucket B; sweep skipped (0 - 0 < 100)
    expect(rl.bucketCount).toBe(2);
    // At t=2000 the next check sweeps: A and B are idle 2000ms >= 1000 TTL -> dropped.
    rl.check("c", "read", "v1", 2_000);
    expect(rl.bucketCount).toBe(1);
  });

  it("sweeps at most once per sweepIntervalMs", () => {
    const rl = new RateLimiter(DEFAULT_THROTTLE_TIERS, {
      idleTtlMs: 1,
      sweepIntervalMs: 1_000,
      maxBuckets: 10_000,
    });
    rl.check("a", "read", "v1", 0); // lastSweep=0
    rl.check("b", "read", "v1", 10); // 10 - 0 < 1000 -> no sweep, A survives despite idle>=ttl
    expect(rl.bucketCount).toBe(2);
    rl.check("c", "read", "v1", 1_000); // 1000 - 0 >= 1000 -> sweep; A and B evicted, C stays
    expect(rl.bucketCount).toBe(1);
  });

  it("keeps a sub-full bucket over the soft cap, reclaiming it only once full", () => {
    // read tier: burst 100 @ 600/min -> full-refill = 10_000ms. TTL disabled here.
    const rl = new RateLimiter(DEFAULT_THROTTLE_TIERS, {
      idleTtlMs: 10_000_000,
      sweepIntervalMs: 1,
      maxBuckets: 1,
    });
    rl.check("a", "read", "v1", 0); // A now sub-full (99/100), lastSeen=0
    // B at t=5 pushes over the cap, but A is idle only 5ms (< 10_000) so it is NOT
    // guaranteed full and must not be evicted — the cap cannot bypass an active bucket.
    rl.check("b", "read", "v1", 5);
    expect(rl.bucketCount).toBe(2);
    // At t=10_005 A has been idle >= its full-refill time, so it is full and reclaimable.
    rl.check("c", "read", "v1", 10_005);
    expect(rl.bucketCount).toBe(1);
  });
});

describe("callerHash", () => {
  it("is a deterministic 8-hex digest", () => {
    expect(callerHash("agent-claude")).toMatch(/^[a-f0-9]{8}$/);
    expect(callerHash("agent-claude")).toBe(callerHash("agent-claude"));
    expect(callerHash("a")).not.toBe(callerHash("b"));
  });

  it("maps a null caller to a stable anonymous bucket", () => {
    expect(callerHash(null)).toMatch(/^[a-f0-9]{8}$/);
    expect(callerHash(null)).toBe(callerHash(null));
  });
});
