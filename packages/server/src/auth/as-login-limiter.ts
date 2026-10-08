// Failure limiter for the operator login and setup forms (design v2 section 8, "Login brute force"):
// a sliding window of failures per key with exponential backoff once the budget is spent. Counters
// live in memory, as the design says: a restart forgives, which costs an attacker nothing they did
// not already have per process lifetime.
//
// Keys are whatever the caller chooses (a submitted username, whether or not it exists, or a peer
// address), so behaviour never depends on the account being real: that is what keeps lockout from
// becoming a way to enumerate users. The table is bounded; the oldest-touched key is dropped first,
// and an attacker who wants to flush a locked account out of it has to submit tens of thousands of
// distinct names, each of which costs a full password verification.

const BASE_LOCK_MS = 30_000;
const DEFAULT_MAX_KEYS = 50_000;

interface Entry {
  failures: number[];
  lockedUntil: number;
  /** Attempts admitted by `reserve` that have not settled yet. */
  pending: number;
}

export interface LimiterOptions {
  /** Failures tolerated inside the window before the key is locked. */
  maxFailures: number;
  windowMs: number;
  maxKeys?: number;
}

export type Lock = { locked: false } | { locked: true; retryAfterMs: number };

export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxKeys: number;

  constructor(private readonly opts: LimiterOptions) {
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Is the key locked right now? Reading it neither counts as an attempt nor extends a lock. */
  check(key: string, now: number): Lock {
    const e = this.entries.get(key);
    if (e === undefined || e.lockedUntil <= now) return { locked: false };
    return { locked: true, retryAfterMs: e.lockedUntil - now };
  }

  /**
   * Admit one attempt, or refuse it. Unlike `check`, an admitted attempt is COUNTED while it runs:
   * the failures already on the books plus the attempts still in flight may not exceed the budget,
   * so N requests that arrive together cannot all slip past a check that only sees settled
   * failures. Past the budget (a lock that has lapsed) one probe at a time is admitted. Every
   * admitted attempt must be settled with `release`, after it has called `fail` or `succeed`.
   */
  reserve(key: string, now: number): Lock {
    const e = this.entries.get(key);
    if (e === undefined) {
      this.entries.set(key, { failures: [], lockedUntil: 0, pending: 1 });
      this.evictOldest();
      return { locked: false };
    }
    if (e.lockedUntil > now) return { locked: true, retryAfterMs: e.lockedUntil - now };
    const settled = e.failures.filter((t) => now - t < this.opts.windowMs).length;
    const room = settled < this.opts.maxFailures ? this.opts.maxFailures - settled : 1;
    if (e.pending >= room) return { locked: true, retryAfterMs: BASE_LOCK_MS };
    e.pending++;
    return { locked: false };
  }

  /** Settle an attempt admitted by `reserve`. Unknown (evicted) keys are ignored. */
  release(key: string): void {
    const e = this.entries.get(key);
    if (e === undefined) return;
    e.pending = Math.max(0, e.pending - 1);
    if (e.pending === 0 && e.failures.length === 0 && e.lockedUntil === 0) this.entries.delete(key);
  }

  /**
   * Record a failure. Once the window holds `maxFailures`, the key is locked for 30 s doubled for
   * each failure beyond that, never longer than the window itself.
   */
  fail(key: string, now: number): void {
    const prior = this.entries.get(key);
    const failures = (prior?.failures ?? []).filter((t) => now - t < this.opts.windowMs);
    failures.push(now);
    const over = failures.length - this.opts.maxFailures;
    const lock =
      over >= 0 ? Math.min(this.opts.windowMs, BASE_LOCK_MS * 2 ** Math.min(over, 20)) : 0;
    this.entries.delete(key);
    this.entries.set(key, {
      failures,
      lockedUntil: lock > 0 ? now + lock : 0,
      pending: prior?.pending ?? 0,
    });
    this.evictOldest();
  }

  /** A success forgets the key's failures; attempts still in flight keep their reservations. */
  succeed(key: string): void {
    const e = this.entries.get(key);
    if (e === undefined) return;
    if (e.pending > 0) {
      e.failures = [];
      e.lockedUntil = 0;
    } else {
      this.entries.delete(key);
    }
  }

  private evictOldest(): void {
    if (this.entries.size <= this.maxKeys) return;
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}
