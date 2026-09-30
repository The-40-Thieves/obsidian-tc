// The default backend: a process-local Map. Zero configuration, zero I/O, and the behavior the
// server has always had — including that a restart (or a second process) starts from full buckets.
import { type BucketSpec, fullRefillMs, type RateLimitBackend } from "./backend";
import { TokenBucket, type TokenBucketResult } from "./bucket";

interface BucketEntry {
  bucket: TokenBucket;
  /** ms for an empty bucket of this tier to refill to capacity; idle past this => full. */
  fullRefillMs: number;
  /** Injected-clock timestamp of the most recent check for this key. */
  lastSeenMs: number;
}

export interface MemoryBackendOptions {
  /** Drop buckets idle at least this long (default 600_000 = 10 min). */
  idleTtlMs?: number;
  /** Soft ceiling on live buckets; only guaranteed-full idle buckets are reclaimed (default 10_000). */
  maxBuckets?: number;
  /** Minimum gap between idle sweeps (default 60_000 = 1 min). */
  sweepIntervalMs?: number;
}

export class MemoryBackend implements RateLimitBackend {
  readonly kind = "memory" as const;
  private readonly buckets = new Map<string, BucketEntry>();
  // Idle-bucket reclamation. A bucket is evicted only once it is guaranteed full (idle past its
  // full-refill time), so re-creating it on the next call yields an identical full bucket and grants
  // no burst — eviction can never be used to bypass the limit. The TTL bounds the map under long
  // uptime; the size cap is an early-reclaim optimization for idle-full buckets when the map is
  // large, NOT a flood defense (a burst of concurrent *active* callers is intentionally never
  // evicted and may exceed maxBuckets until they go idle).
  private readonly idleTtlMs: number;
  private readonly maxBuckets: number;
  private readonly sweepIntervalMs: number;
  private lastSweepMs: number | null = null;

  constructor(opts: MemoryBackendOptions = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? 600_000; // 10 min >> max full-refill (~20s)
    this.maxBuckets = opts.maxBuckets ?? 10_000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
  }

  async consume(
    key: string,
    spec: BucketSpec,
    n: number,
    nowMs: number,
  ): Promise<TokenBucketResult> {
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = {
        bucket: new TokenBucket(spec),
        fullRefillMs: fullRefillMs(spec),
        lastSeenMs: nowMs,
      };
      this.buckets.set(key, entry);
    }
    entry.lastSeenMs = nowMs;
    const res = entry.bucket.tryRemove(n, nowMs);
    this.sweep(nowMs);
    return res;
  }

  /**
   * Rate-limited to once per `sweepIntervalMs` and driven entirely by the injected clock — no
   * timers. Phase 1 drops buckets idle past `idleTtlMs` (which exceeds every tier's full-refill
   * time, so they are always full and safe to drop). Phase 2, only when over `maxBuckets`, evicts
   * the most-idle buckets that are *guaranteed full* (idle >= their own full-refill time), oldest
   * first; a sub-full bucket is never evicted, so a caller mid-burst cannot reset its allowance by
   * forcing eviction.
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

  /** Live bucket count, exposed for eviction tests. */
  get bucketCount(): number {
    return this.buckets.size;
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }
}
