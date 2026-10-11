// notes_fts availability, as a state per connection rather than a memoized boolean.
//
// ensureNotesFts used to cache `false` for the life of the connection on ANY error, including a
// transient SQLITE_BUSY. One contended moment then ran the whole process without full-text search,
// with no error and no health signal (GH #1209). The state kept here separates the three outcomes:
//   available    - provisioned; memoized.
//   transient    - lock contention; NOT memoized, retried on a bounded backoff.
//   terminal     - disabled, no notes table, or a real failure (missing module, corrupt index);
//                  memoized, and the reason says which.
import type { Database } from "../db/types";

export const FTS_MAX_ATTEMPTS = 10;
export const FTS_BACKOFF_BASE_MS = 1_000;
export const FTS_BACKOFF_CAP_MS = 30_000;

export type FtsUnavailableReason =
  | "lock_contention"
  | "disabled"
  | "no_notes_table"
  | "provision_failed"
  | "integrity_failed"
  | "not_probed";

/** What server_health, get_index_status and doctor report. */
export type FtsStatus =
  | { state: "available" }
  | {
      state: "recovering";
      reason: "lock_contention";
      attempts: number;
      max_attempts: number;
      last_error: string;
      next_retry_at: number;
    }
  | {
      state: "unavailable";
      reason: FtsUnavailableReason;
      /** Set for lock_contention: the background retries are spent (a later index write still retries). */
      attempts?: number;
      last_error?: string;
    };

export type FtsRecord =
  | { kind: "available" }
  | {
      kind: "terminal";
      reason: Exclude<FtsUnavailableReason, "lock_contention">;
      lastError?: string;
    }
  | { kind: "transient"; attempts: number; lastError: string; nextRetryAt: number };

const records = new WeakMap<Database, FtsRecord>();
const listeners = new WeakMap<
  Database,
  Set<(next: FtsRecord, prev: FtsRecord | undefined) => void>
>();

export function ftsRecord(db: Database): FtsRecord | undefined {
  return records.get(db);
}

export function setFtsRecord(db: Database, next: FtsRecord): void {
  const prev = records.get(db);
  records.set(db, next);
  for (const fn of [...(listeners.get(db) ?? [])]) {
    try {
      fn(next, prev);
    } catch {
      /* a listener never affects provisioning */
    }
  }
}

/** Observe state changes on one connection. Returns the unsubscribe. */
export function subscribeFts(
  db: Database,
  fn: (next: FtsRecord, prev: FtsRecord | undefined) => void,
): () => void {
  let set = listeners.get(db);
  if (!set) {
    set = new Set();
    listeners.set(db, set);
  }
  set.add(fn);
  return () => void set.delete(fn);
}

/** Exponential backoff after the Nth failed attempt, capped. */
export function ftsBackoffMs(attempts: number): number {
  return Math.min(FTS_BACKOFF_CAP_MS, FTS_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export function ftsStatus(db: Database): FtsStatus {
  const r = records.get(db);
  if (!r) return { state: "unavailable", reason: "not_probed" };
  if (r.kind === "available") return { state: "available" };
  if (r.kind === "terminal") {
    return {
      state: "unavailable",
      reason: r.reason,
      ...(r.lastError !== undefined ? { last_error: r.lastError } : {}),
    };
  }
  if (r.attempts >= FTS_MAX_ATTEMPTS) {
    return {
      state: "unavailable",
      reason: "lock_contention",
      attempts: r.attempts,
      last_error: r.lastError,
    };
  }
  return {
    state: "recovering",
    reason: "lock_contention",
    attempts: r.attempts,
    max_attempts: FTS_MAX_ATTEMPTS,
    last_error: r.lastError,
    next_retry_at: r.nextRetryAt,
  };
}
