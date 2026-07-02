// THE-292 — periodic cache.db maintenance. Expiry was lazy-only: idempotency rows and elicit
// tokens are checked at read time but never purged, and the event_log retention config
// (observability.retention.eventLogDays) had no enforcement — cache.db grew without bound. The
// sweep DELETEs expired rows, trims event_log, then runs PRAGMA optimize. It is deliberately
// EXPIRED-ONLY for idempotency rows: reaping a crashed in-flight row here could cross-attach a
// stale completion onto a fresh claim — the dispatch-path reclaim (idempotencyReclaimSeconds,
// THE-293) owns that concern. No automatic VACUUM (disruptive under WAL).
import type { Database } from "./types";

export interface SweepCounts {
  idempotency_keys: number;
  elicit_tokens: number;
  event_log: number;
}

export function runMaintenanceSweep(
  db: Database,
  opts: { now: () => number; eventLogDays: number },
): SweepCounts {
  const t = opts.now();
  const idem = db.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").run(t).changes;
  const elicit = db.prepare("DELETE FROM elicit_tokens WHERE expires_at <= ?").run(t).changes;
  const cutoff = t - opts.eventLogDays * 86_400_000;
  const events = db.prepare("DELETE FROM event_log WHERE ts < ?").run(cutoff).changes;
  try {
    db.exec("PRAGMA optimize");
  } catch {
    /* optimize is advisory; a failure must not mask the delete counts */
  }
  return { idempotency_keys: idem, elicit_tokens: elicit, event_log: events };
}

export interface MaintenanceDeps {
  db: Database;
  intervalMs: number;
  eventLogDays: number;
  now?: () => number;
  onSweep?: (counts: SweepCounts) => void;
  onError?: (e: unknown) => void;
}

/** Start the unref'd periodic sweep; returns a stop function. The timer never keeps the
 *  process alive (stdio EOF still exits), and a failing sweep routes to onError without
 *  escaping — expired rows remain lazily rejected on read, so correctness never depends
 *  on the sweep. */
export function startMaintenanceSweep(deps: MaintenanceDeps): () => void {
  const timer = setInterval(() => {
    try {
      const counts = runMaintenanceSweep(deps.db, {
        now: deps.now ?? Date.now,
        eventLogDays: deps.eventLogDays,
      });
      deps.onSweep?.(counts);
    } catch (e) {
      try {
        deps.onError?.(e);
      } catch {
        /* error sink must never throw */
      }
    }
  }, deps.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
