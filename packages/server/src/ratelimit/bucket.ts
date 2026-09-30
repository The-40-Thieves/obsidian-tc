// The token-bucket arithmetic, in ONE place. The memory backend runs it in-process, the sqlite
// backend runs it inside a write transaction, and the redis backend mirrors it in Lua (its script
// is asserted equal to this by the conformance suite's differential case). The clock is always an
// explicit `nowMs`, so refill/burst/exhaustion stay deterministic and testable with no sleeps.

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

/** A bucket's persisted state: the fractional token count and the clock of its last refill. */
export interface BucketState {
  tokens: number;
  /** null until the first attempt, which only anchors the clock (no refill on the first touch). */
  lastMs: number | null;
}

/**
 * Lazily refill `state` to `nowMs`, then try to remove `n` tokens. Mutates `state` and returns the
 * decision. A clock that does not advance (or runs backwards, e.g. across instances with skewed
 * clocks) refills nothing and never rewinds `lastMs`, so skew can delay a refill but never mint one.
 */
export function takeFromBucket(
  state: BucketState,
  spec: Pick<TokenBucketOptions, "capacity" | "refillTokens" | "intervalMs">,
  n: number,
  nowMs: number,
): TokenBucketResult {
  const ratePerMs = spec.refillTokens / spec.intervalMs;
  if (state.lastMs === null) {
    state.lastMs = nowMs;
  } else {
    const elapsed = nowMs - state.lastMs;
    if (elapsed > 0) {
      state.tokens = Math.min(spec.capacity, state.tokens + elapsed * ratePerMs);
      state.lastMs = nowMs;
    }
  }
  if (state.tokens >= n) {
    state.tokens -= n;
    return { ok: true, retryAfterMs: 0, tokens: Math.floor(state.tokens) };
  }
  const deficit = n - state.tokens;
  const retryAfterMs = ratePerMs > 0 ? Math.ceil(deficit / ratePerMs) : Number.POSITIVE_INFINITY;
  return { ok: false, retryAfterMs, tokens: Math.floor(state.tokens) };
}

/**
 * A single continuous-refill token bucket. `tryRemove(n, nowMs)` lazily refills
 * based on elapsed time before deciding, so it never needs a background timer.
 */
export class TokenBucket {
  private readonly spec: Pick<TokenBucketOptions, "capacity" | "refillTokens" | "intervalMs">;
  private readonly state: BucketState;

  constructor(opts: TokenBucketOptions) {
    this.spec = opts;
    this.state = { tokens: opts.initialTokens ?? opts.capacity, lastMs: null };
  }

  tryRemove(n: number, nowMs: number): TokenBucketResult {
    return takeFromBucket(this.state, this.spec, n, nowMs);
  }
}
