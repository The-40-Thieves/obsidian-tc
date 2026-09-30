// Deterministic token-bucket throttle (G2.4 §Rate limits). A token bucket per
// (caller_hash, scope_class, vault_id). Where bucket state lives is a pluggable backend
// (./ratelimit): `memory` (default, process-local; a restart resets buckets), `sqlite` (shared by
// every process on one host through the cacheDir) or `redis` (shared across instances).
// The clock is always passed in as an explicit `nowMs`, so refill/burst/exhaustion
// are deterministic and testable with no wall-clock sleeps.
import { createHash } from "node:crypto";
import type { BucketSpec, RateLimitBackend, RateLimitFailurePolicy } from "./ratelimit/backend";
import type { TokenBucketResult } from "./ratelimit/bucket";
import { MemoryBackend, type MemoryBackendOptions } from "./ratelimit/memory-backend";

export type { RateLimitFailurePolicy } from "./ratelimit/backend";
export {
  TokenBucket,
  type TokenBucketOptions,
  type TokenBucketResult,
} from "./ratelimit/bucket";

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
  // Single destructive deletes share the write tier (THE-212); bulk_delete resolves to `bulk`.
  delete: { perMinute: 60, burst: 20 },
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
  /** Set when the call was refused because the shared backend is down under `fail-closed`, not
   *  because the caller's bucket is empty. Such a refusal is not a rate-limit hit. */
  reason?: "backend_unavailable";
}

const INTERVAL_MS = 60_000;

export interface RateLimiterOptions extends MemoryBackendOptions {
  /** Where bucket state lives. Default: a process-local MemoryBackend built from the options above. */
  backend?: RateLimitBackend;
  /** Behavior while `backend` is unreachable (default "fail-open"). Irrelevant for memory. */
  failurePolicy?: RateLimitFailurePolicy;
  /** After a backend failure, skip the backend for this long (injected clock) before probing it
   *  again, so an outage costs one failed call per window rather than one per request (default 5000). */
  backendRetryMs?: number;
  /** Fired ONCE when an outage begins (not per request). */
  onBackendDown?: (info: {
    backend: string;
    policy: RateLimitFailurePolicy;
    error: unknown;
  }) => void;
  /** Fired ONCE when the backend answers again after an outage. */
  onBackendUp?: (info: { backend: string }) => void;
}

/**
 * Per-(caller, scope_class, vault) token-bucket rate limiter. An unknown scope
 * class is unlimited (no tier configured). Throttle hits are counted per
 * (vault, scope_class) for the `obsidian_tc_rate_limit_hits_total` metric.
 *
 * A shared backend that throws is an OUTAGE, never a throttle: the failure policy decides the
 * call, the first failure of an outage is reported once through `onBackendDown`, and the backend is
 * not touched again until `backendRetryMs` has passed.
 */
export class RateLimiter {
  private readonly tiers: ThrottleTiers;
  private readonly hits = new Map<string, number>();
  private readonly backend: RateLimitBackend;
  /** Per-process buckets: the memory backend itself, or the fail-open fallback for a shared one. */
  private readonly local: MemoryBackend;
  private readonly failurePolicy: RateLimitFailurePolicy;
  private readonly backendRetryMs: number;
  private readonly opts: RateLimiterOptions;
  private inOutage = false;
  private retryAtMs = 0;

  constructor(tiers: ThrottleTiers = DEFAULT_THROTTLE_TIERS, opts: RateLimiterOptions = {}) {
    this.tiers = tiers;
    this.opts = opts;
    this.local = opts.backend instanceof MemoryBackend ? opts.backend : new MemoryBackend(opts);
    this.backend = opts.backend ?? this.local;
    this.failurePolicy = opts.failurePolicy ?? "fail-open";
    this.backendRetryMs = opts.backendRetryMs ?? 5000;
  }

  async check(
    callerHashValue: string,
    scopeClass: string,
    vaultId: string,
    nowMs: number,
    n = 1,
  ): Promise<ThrottleDecision> {
    const tier = this.tiers[scopeClass];
    if (!tier) {
      return { ok: true, scopeClass, retryAfterSeconds: 0, currentBurst: -1, currentRate: -1 };
    }
    const spec: BucketSpec = {
      capacity: tier.burst,
      refillTokens: tier.perMinute,
      intervalMs: INTERVAL_MS,
    };
    const key = `${callerHashValue}|${scopeClass}|${vaultId}`;
    const res = await this.consume(key, spec, n, nowMs);
    if (res === "unavailable") {
      return {
        ok: false,
        scopeClass,
        retryAfterSeconds: Math.max(1, Math.ceil(this.backendRetryMs / 1000)),
        currentBurst: 0,
        currentRate: tier.perMinute,
        reason: "backend_unavailable",
      };
    }
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

  private async consume(
    key: string,
    spec: BucketSpec,
    n: number,
    nowMs: number,
  ): Promise<TokenBucketResult | "unavailable"> {
    if (this.backend === this.local) return this.local.consume(key, spec, n, nowMs);
    if (this.inOutage && nowMs < this.retryAtMs) return this.duringOutage(key, spec, n, nowMs);
    try {
      const res = await this.backend.consume(key, spec, n, nowMs);
      if (this.inOutage) {
        this.inOutage = false;
        this.opts.onBackendUp?.({ backend: this.backend.kind });
      }
      return res;
    } catch (error) {
      this.retryAtMs = nowMs + this.backendRetryMs;
      if (!this.inOutage) {
        this.inOutage = true;
        this.opts.onBackendDown?.({
          backend: this.backend.kind,
          policy: this.failurePolicy,
          error,
        });
      }
      return this.duringOutage(key, spec, n, nowMs);
    }
  }

  private duringOutage(
    key: string,
    spec: BucketSpec,
    n: number,
    nowMs: number,
  ): Promise<TokenBucketResult | "unavailable"> {
    return this.failurePolicy === "fail-closed"
      ? Promise.resolve("unavailable")
      : this.local.consume(key, spec, n, nowMs);
  }

  /** Live process-local bucket count, exposed for eviction tests. */
  get bucketCount(): number {
    return this.local.bucketCount;
  }

  /** Release the backend's connections/handles. */
  async close(): Promise<void> {
    await this.backend.close();
    if (this.local !== this.backend) await this.local.close();
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
