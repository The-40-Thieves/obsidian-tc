// The seam between the limiter's policy (tiers, decisions, hit counters, failure policy) and where
// bucket state lives. Every backend answers ONE question atomically: "refill this bucket to nowMs
// and try to take n tokens" — so N processes or instances sharing a backend can never both spend the
// same token.
import type { TokenBucketOptions, TokenBucketResult } from "./bucket";

export type RateLimitBackendKind = "memory" | "sqlite" | "redis";

/** The shape of one bucket: what `consume` needs to refill it and (on first sight) create it. */
export type BucketSpec = Pick<TokenBucketOptions, "capacity" | "refillTokens" | "intervalMs">;

/** What a governed call does while the shared backend cannot be reached. `fail-open` keeps serving
 *  and enforces the limits per process from local buckets (the limit degrades from shared to
 *  per-process, it is not lifted); `fail-closed` refuses the call as `throttled`. */
export type RateLimitFailurePolicy = "fail-open" | "fail-closed";

export interface RateLimitBackend {
  readonly kind: RateLimitBackendKind;
  /**
   * Atomically refill the bucket at `key` to `nowMs` and try to remove `n` tokens. A missing bucket
   * starts full. Must reject (not resolve `ok: false`) when the store itself is unreachable — the
   * limiter's failure policy keys on the rejection, and a store error must never read as a throttle.
   */
  consume(key: string, spec: BucketSpec, n: number, nowMs: number): Promise<TokenBucketResult>;
  /** Release connections/handles. Idempotent. */
  close(): Promise<void>;
}

/** Idle time after which a bucket is guaranteed full again, so a store may drop it without effect. */
export function fullRefillMs(spec: BucketSpec): number {
  return spec.refillTokens > 0
    ? Math.ceil((spec.capacity * spec.intervalMs) / spec.refillTokens)
    : 0;
}

/** Strip `user:password@` from any URL-shaped text so a connection error can never leak a secret
 *  into a log line or an error message. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1<redacted>@");
}
