// Failure policy: what a governed call does when the SHARED bucket store is unreachable.
// A store error is an outage, never a throttle; it is reported once per outage, not per request;
// and the connection URL (which carries the password) never reaches a log line.
import { describe, expect, it, vi } from "vitest";
import type { BucketSpec, RateLimitBackend } from "../src/ratelimit/backend";
import type { TokenBucketResult } from "../src/ratelimit/bucket";
import { outageHooks } from "../src/ratelimit/outage-hooks";
import { RedisBackend } from "../src/ratelimit/redis-backend";
import { RateLimiter } from "../src/throttle";

const TIERS = { bulk: { perMinute: 10, burst: 3 } };

/** A backend whose availability the test flips. Counts every call that reaches it. */
class FlakyBackend implements RateLimitBackend {
  readonly kind = "redis" as const;
  up = true;
  calls = 0;
  private readonly buckets = new Map<string, number>();
  async consume(key: string, spec: BucketSpec, n: number): Promise<TokenBucketResult> {
    this.calls++;
    if (!this.up)
      throw new Error("connect ECONNREFUSED redis://default:s3cr3t@redis.internal:6379");
    const have = this.buckets.get(key) ?? spec.capacity;
    if (have >= n) {
      this.buckets.set(key, have - n);
      return { ok: true, retryAfterMs: 0, tokens: have - n };
    }
    return { ok: false, retryAfterMs: 6000, tokens: have };
  }
  async close(): Promise<void> {}
}

function limiter(backend: RateLimitBackend, policy: "fail-open" | "fail-closed") {
  const down = vi.fn();
  const up = vi.fn();
  const rl = new RateLimiter(TIERS, {
    backend,
    failurePolicy: policy,
    backendRetryMs: 5_000,
    onBackendDown: down,
    onBackendUp: up,
  });
  return { rl, down, up };
}

describe("fail-open", () => {
  it("keeps serving during an outage and enforces the limit per process from local buckets", async () => {
    const b = new FlakyBackend();
    b.up = false;
    const { rl } = limiter(b, "fail-open");
    const granted: boolean[] = [];
    for (let i = 0; i < 5; i++) granted.push((await rl.check("c0ffee00", "bulk", "v1", 0)).ok);
    expect(granted).toEqual([true, true, true, false, false]); // burst 3: degraded, not lifted
    expect(rl.snapshot()).toEqual([{ vault: "v1", scope_class: "bulk", hits: 2 }]);
  });
});

describe("fail-closed", () => {
  it("refuses governed calls during an outage, marked backend_unavailable and not counted as hits", async () => {
    const b = new FlakyBackend();
    b.up = false;
    const { rl } = limiter(b, "fail-closed");
    const d = await rl.check("c0ffee00", "bulk", "v1", 0);
    expect(d).toMatchObject({ ok: false, reason: "backend_unavailable", scopeClass: "bulk" });
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(rl.snapshot()).toEqual([]); // an outage symptom is not a rate-limit hit
  });

  it("still leaves unlimited (unknown) scope classes unlimited", async () => {
    const b = new FlakyBackend();
    b.up = false;
    const { rl } = limiter(b, "fail-closed");
    expect((await rl.check("c0ffee00", "mystery", "v1", 0)).ok).toBe(true);
  });
});

describe.each(["fail-open", "fail-closed"] as const)("outage reporting (%s)", (policy) => {
  it("reports ONCE per outage and touches the dead backend once per retry window, not per request", async () => {
    const b = new FlakyBackend();
    const { rl, down, up } = limiter(b, policy);
    expect((await rl.check("c0ffee00", "bulk", "v1", 0)).ok).toBe(true); // healthy
    b.up = false;
    b.calls = 0;
    for (let i = 0; i < 200; i++) await rl.check("c0ffee00", "bulk", "v1", 1_000 + i);
    expect(down).toHaveBeenCalledTimes(1);
    expect(b.calls).toBe(1); // breaker: 199 requests never reached the dead backend

    // window elapses: one probe, still down, still ONE report
    for (let i = 0; i < 50; i++) await rl.check("c0ffee00", "bulk", "v1", 7_000 + i);
    expect(b.calls).toBe(2);
    expect(down).toHaveBeenCalledTimes(1);
    expect(up).not.toHaveBeenCalled();

    // recovery is reported once, and the shared bucket answers again
    b.up = true;
    await rl.check("c0ffee00", "bulk", "v1", 13_000);
    await rl.check("c0ffee00", "bulk", "v1", 13_001);
    expect(up).toHaveBeenCalledTimes(1);

    // a second, separate outage is a second report
    b.up = false;
    await rl.check("c0ffee00", "bulk", "v1", 20_000);
    await rl.check("c0ffee00", "bulk", "v1", 20_001);
    expect(down).toHaveBeenCalledTimes(2);
    expect(down.mock.calls[0]?.[0]).toMatchObject({ backend: "redis", policy });
  });
});

describe("outage log line and metric (operator-facing)", () => {
  it("counts the outage once and never prints the URL's password", async () => {
    const lines: string[] = [];
    const inc = vi.fn();
    const hooks = outageHooks({ incRateLimitBackendOutage: inc }, (l) => lines.push(l));
    const b = new FlakyBackend();
    b.up = false;
    const rl = new RateLimiter(TIERS, { backend: b, failurePolicy: "fail-open", ...hooks });
    for (let i = 0; i < 100; i++) await rl.check("c0ffee00", "bulk", "v1", i);
    expect(inc).toHaveBeenCalledExactlyOnceWith("redis");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('rate-limit backend "redis" is unreachable');
    expect(lines[0]).toContain("fail-open");
    expect(lines[0]).not.toContain("s3cr3t");
    expect(lines[0]).toContain("redis://<redacted>@redis.internal:6379");
  });

  it("a REAL connection failure against a URL with a password never leaks it", async () => {
    const lines: string[] = [];
    const backend = await RedisBackend.create({
      url: "redis://default:hunter2@127.0.0.1:1", // nothing listens on port 1
      keyPrefix: "otc-test:dead:",
      connectTimeoutMs: 300,
    });
    const rl = new RateLimiter(TIERS, {
      backend,
      failurePolicy: "fail-open",
      ...outageHooks({ incRateLimitBackendOutage: () => {} }, (l) => lines.push(l)),
    });
    const d = await rl.check("c0ffee00", "bulk", "v1", 0);
    expect(d.ok).toBe(true); // fail-open: served from the local fallback
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("hunter2");
    await rl.close();
  });
});
