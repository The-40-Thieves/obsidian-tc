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

/**
 * Per-(caller, scope_class, vault) token-bucket rate limiter. An unknown scope
 * class is unlimited (no tier configured). Throttle hits are counted per
 * (vault, scope_class) for the `obsidian_tc_rate_limit_hits_total` metric.
 */
export class RateLimiter {
  private readonly tiers: ThrottleTiers;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly hits = new Map<string, number>();

  constructor(tiers: ThrottleTiers = DEFAULT_THROTTLE_TIERS) {
    this.tiers = tiers;
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
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket({
        capacity: tier.burst,
        refillTokens: tier.perMinute,
        intervalMs: INTERVAL_MS,
      });
      this.buckets.set(key, bucket);
    }
    const res = bucket.tryRemove(n, nowMs);
    if (!res.ok) {
      const hk = `${vaultId}|${scopeClass}`;
      this.hits.set(hk, (this.hits.get(hk) ?? 0) + 1);
    }
    return {
      ok: res.ok,
      scopeClass,
      retryAfterSeconds: res.ok ? 0 : Math.ceil(res.retryAfterMs / 1000),
      currentBurst: res.tokens,
      currentRate: tier.perMinute,
    };
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
