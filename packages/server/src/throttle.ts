// Deterministic token-bucket throttle (THE-182 / M6, G2.4 §Rate limits). A token
// bucket per (caller_hash, scope_class, vault_id), in-memory only (process-local;
// restart resets buckets — multi-process limiting is deferred to V1.x per G2.4).
// The clock is always passed in as an explicit `nowMs`, so refill/burst/exhaustion
// are deterministic and testable with no wall-clock sleeps. M6 consumes the `bulk`
// tier from the bulk tools; the other tiers exist (and are tested) so M7 can promote
// the limiter to a dispatch-wide policy gate.
import { createHash } from "node:crypto";

export interface TokenBucketOptions {
  /** Maximum tokens the bucket holds (the burst). */
  capacity: number;
  /** Tokens replenished per `intervalMs` (the sustained rate). */
  refillTokens: number;
  /** Refill window in milliseconds. */
  intervalMs: number;
  /** Starting token count; defaults to a full bucket. */
  initialTokens?: number;
}

export interface TokenBucketResult {
  ok: boolean;
  /** Milliseconds until enough tokens refill for the requested amount (0 when ok). */
  retryAfterMs: number;
  /** Tokens remaining after the attempt (floored to a whole token). */
  tokens: number;
}

/**
 * A single continuous-refill token bucket. `tryRemove(n, nowMs)` lazily refills
 * based on elapsed time before deciding, so it never needs a background timer.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly ratePerMs: number;
  private tokens: number;
  private lastMs: number | null = null;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.ratePerMs = opts.refillTokens / opts.intervalMs;
    this.tokens = opts.initialTokens ?? opts.capacity;
  }

  private refill(nowMs: number): void {
    if (this.lastMs === null) {
      this.lastMs = nowMs;
      return;
    }
    const elapsed = nowMs - this.lastMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
    this.lastMs = nowMs;
  }

  tryRemove(n: number, nowMs: number): TokenBucketResult {
    this.refill(nowMs);
    if (this.tokens >= n) {
      this.tokens -= n;
      return { ok: true, retryAfterMs: 0, tokens: Math.floor(this.tokens) };
    }
    const deficit = n - this.tokens;
    const retryAfterMs =
      this.ratePerMs > 0 ? Math.ceil(deficit / this.ratePerMs) : Number.POSITIVE_INFINITY;
    return { ok: false, retryAfterMs, tokens: Math.floor(this.tokens) };
  }
}

export interface ThrottleTier {
  /** Sustained operations per minute. */
  perMinute: number;
  /** Burst capacity (instantaneous ceiling). */
  burst: number;
}

export type ThrottleTiers = Record<string, ThrottleTier>;

/** G2.4 tiered defaults (security draft §Rate limits). */
export const DEFAULT_THROTTLE_TIERS: ThrottleTiers = {
  read: { perMinute: 600, burst: 100 },
  write: { perMinute: 60, burst: 20 },
  bulk: { perMinute: 10, burst: 3 },
  execute: { perMinute: 5, burst: 1 },
  admin: { perMinute: 5, burst: 1 },
};

export interface ThrottleDecision {
  ok: boolean;
  scopeClass: string;
  /** Seconds the caller should back off (0 when ok). */
  retryAfterSeconds: number;
  /** Tokens currently available (-1 when the class is unlimited). */
  currentBurst: number;
  /** Configured sustained rate per minute (-1 when the class is unlimited). */
  currentRate: number;
}

const INTERVAL_MS = 60_000;

interface BucketEntry {
  bucket: TokenBucket;
  /** ms for an empty bucket of this tier to refill to capacity; idle past this => full. */
  fullRefillMs: number;
  /** Injected-clock timestamp of the most recent check for this key. */
  lastSeenMs: number;
}

export interface RateLimiterOptions {
  /** Drop buckets idle at least this long (default 600_000 = 10 min). */
  idleTtlMs?: number;
  /** Soft ceiling on live buckets; only guaranteed-full idle buckets are reclaimed (default 10_000). */
  maxBuckets?: number;
  /** Minimum gap between idle sweeps (default 60_000 = 1 min). */
  sweepIntervalMs?: number;
}

/**
 * Per-(caller, scope_class, vault) token-bucket rate limiter. An unknown scope
 * class is unlimited (no tier configured). Throttle hits are counted per
 * (vault, scope_class) for the `obsidian_tc_rate_limit_hits_total` metric.
 */
export class RateLimiter {
  private readonly tiers: ThrottleTiers;
  private readonly buckets = new Map<string, BucketEntry>();
  private readonly hits = new Map<string, number>();
  // Idle-bucket reclamation (THE-213). A bucket is evicted only once it is
  // guaranteed full (idle past its full-refill time), so re-creating it on the
  // next call yields an identical full bucket and grants no burst — eviction can
  // never be used to bypass the limit. The TTL bounds the map under long uptime;
  // the size cap is an early-reclaim optimization for idle-full buckets when the
  // map is large, NOT a flood defense (a burst of concurrent *active* callers is
  // intentionally never evicted and may exceed maxBuckets until they go idle).
  private readonly idleTtlMs: number;
  private readonly maxBuckets: number;
  private readonly sweepIntervalMs: number;
  private lastSweepMs: number | null = null;

  constructor(tiers: ThrottleTiers = DEFAULT_THROTTLE_TIERS, opts: RateLimiterOptions = {}) {
    this.tiers = tiers;
    this.idleTtlMs = opts.idleTtlMs ?? 600_000; // 10 min >> max full-refill (~20s)
    this.maxBuckets = opts.maxBuckets ?? 10_000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
  }

  check(
    callerHashValue: string,
    scopeClass: string,
    vaultId: string,
    nowMs: number,
    n = 1,
  ): ThrottleDecision {
    const tier = this.tiers[scopeClass];
    if (!tier) {
      return { ok: true, scopeClass, retryAfterSeconds: 0, currentBurst: -1, currentRate: -1 };
    }
    const key = `${callerHashValue}|${scopeClass}|${vaultId}`;
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = {
        bucket: new TokenBucket({
          capacity: tier.burst,
          refillTokens: tier.perMinute,
          intervalMs: INTERVAL_MS,
        }),
        fullRefillMs:
          tier.perMinute > 0 ? Math.ceil((tier.burst * INTERVAL_MS) / tier.perMinute) : 0,
        lastSeenMs: nowMs,
      };
      this.buckets.set(key, entry);
    }
    entry.lastSeenMs = nowMs;
    const res = entry.bucket.tryRemove(n, nowMs);
    if (!res.ok) {
      const hk = `${vaultId}|${scopeClass}`;
      this.hits.set(hk, (this.hits.get(hk) ?? 0) + 1);
    }
    this.sweep(nowMs);
    return {
      ok: res.ok,
      scopeClass,
      retryAfterSeconds: res.ok ? 0 : Math.ceil(res.retryAfterMs / 1000),
      currentBurst: res.tokens,
      currentRate: tier.perMinute,
    };
  }

  /**
   * Idle-bucket reclamation (THE-213). Rate-limited to once per `sweepIntervalMs`
   * and driven entirely by the injected clock — no timers. Phase 1 drops buckets
   * idle past `idleTtlMs` (which exceeds every tier's full-refill time, so they are
   * always full and safe to drop). Phase 2, only when over `maxBuckets`, evicts the
   * most-idle buckets that are *guaranteed full* (idle >= their own full-refill
   * time), oldest first; a sub-full bucket is never evicted, so a caller mid-burst
   * cannot reset its allowance by forcing eviction.
   */
  private sweep(nowMs: number): void {
    if (this.lastSweepMs !== null && nowMs - this.lastSweepMs < this.sweepIntervalMs) return;
    this.lastSweepMs = nowMs;
    for (const [key, e] of this.buckets) {
      if (nowMs - e.lastSeenMs >= this.idleTtlMs) this.buckets.delete(key);
    }
    if (this.buckets.size <= this.maxBuckets) return;
    const evictable = [...this.buckets.entries()]
      .filter(([, e]) => nowMs - e.lastSeenMs >= e.fullRefillMs)
      .sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
    for (const [key] of evictable) {
      if (this.buckets.size <= this.maxBuckets) break;
      this.buckets.delete(key);
    }
  }

  /** Live bucket count, exposed for eviction tests (THE-213). */
  get bucketCount(): number {
    return this.buckets.size;
  }

  /** Throttle-hit counters for the metrics snapshot, one row per (vault, scope_class). */
  snapshot(): Array<{ vault: string; scope_class: string; hits: number }> {
    return [...this.hits.entries()].map(([k, hits]) => {
      const sep = k.indexOf("|");
      return { vault: k.slice(0, sep), scope_class: k.slice(sep + 1), hits };
    });
  }
}

/** 8-hex caller digest (G2.4 bounds Prometheus/limiter cardinality at 8 hex chars). */
export function callerHash(caller: string | null): string {
  return createHash("sha256")
    .update(caller ?? "anonymous", "utf8")
    .digest("hex")
    .slice(0, 8);
}
