// Per-vault (really per-cacheDir — the granularity cache.db already uses) indexing LEADER LOCK.
// Several MCP stdio processes against the same vault config previously all ran boot reconcile/
// embed and watcher-driven index writes concurrently — an N-times CPU storm and a real
// multi-writer race on one shared cache.db.
//
// Exactly one process becomes "leader": the one holding an UNCOMMITTED `BEGIN EXCLUSIVE`
// transaction on a side SQLite file next to cache.db (`vault-lock.db`). Followers retry on a
// jittered timer and promote when the leader's transaction releases — automatic on ANY holder
// exit, including SIGKILL, since `BEGIN EXCLUSIVE` is a real OS-level lock, never application
// state needing a stale-timeout policy. `PRAGMA busy_timeout=0` makes contention fail immediately
// — "busy" always means "someone else is leader".
//
// GC TRAP (read before touching this file): a `bun:sqlite` `Database` with no reachable JS
// reference is finalized by Bun's GC, which CLOSES the native connection and silently releases
// the lock. A holder must keep a STRONG reference to its `Database` AND a closure that actually
// USES it (an unused capture is dropped by JSC); test/vault-lock-gc-trap.test.ts pins this
// (Bun-only). Uses `openDatabase` rather than a bespoke connection so the returned port's own
// closures (over the native handle) keep it reachable, plus a belt-and-braces keepalive tick.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/open";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../db/pragmas";
import type { Database } from "../db/types";
// Reuses close()'s own SHUTDOWN_RECONCILE_OVERLAP bounded-join primitive.
import { joinInFlightReconcile } from "./shutdown-phase";

export const LOCK_FILE_NAME = "vault-lock.db";
const STATUS_FILE_NAME = "vault-lock.status.json";
/** COLD_BOOT_PRELOCK: withBootstrapBarrier's OWN file, deliberately NOT vault-lock.db. Sharing one
 *  file DEADLOCKED: the barrier winner becomes leader and holds vault-lock.db's EXCLUSIVE lock
 *  forever, permanently blocking a loser still busy-retrying its own transient barrier acquire on
 *  that same file. */
const BOOTSTRAP_BARRIER_FILE_NAME = "vault-lock-bootstrap.db";

/** Follower retry jitter window per the design doc (5-15s). */
export const DEFAULT_RETRY_MIN_MS = 5000;
export const DEFAULT_RETRY_MAX_MS = 15000;

/** How often a leader's keepalive tick reads through its lock connection (GC trap header) and runs
 *  the LOCK_TXN_LOSS/LOCK_FILE_REPLACEMENT checks — overridable for tests. */
const KEEPALIVE_MS = 1000;

/** Bounded wait for `withBootstrapBarrier`'s blocking `BEGIN IMMEDIATE` — long enough for a slow
 *  concurrent migration, short enough that a truly stuck holder still fails boot loudly. */
const BOOTSTRAP_BARRIER_TIMEOUT_MS = 60_000;

/** dev+inode identity of a stat'd file — LOCK_FILE_REPLACEMENT's mismatch check compares this
 *  against a fresh stat of the same PATH on every keepalive tick. BIGINT, deliberately: on Windows
 *  `ino` is the NTFS file ID, a 64-bit value (sequence number in the high bits) that routinely
 *  exceeds 2^53, so the plain-number `stat` rounds it — two different files can compare equal and
 *  a replaced lock file goes undetected. */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export function statIdentity(path: string): FileIdentity | undefined {
  try {
    const s = statSync(path, { bigint: true });
    return { dev: s.dev, ino: s.ino };
  } catch {
    return undefined;
  }
}

/** F4: a follower's most recent NON-BUSY acquisition failure (busy contention never populates
 *  this); `count` is cumulative across the election's life. */
export interface LockErrorInfo {
  message: string;
  code?: string;
  count: number;
  lastAt: string;
}

// Every `on*`/`open*`/`statIdentity` option below is a TEST HOOK, never set by production — each
// lets a test inject a race without touching a file another connection still has open (Windows).
export interface VaultLeaderElectionOptions {
  /** Same directory cache.db lives in — the lock file sits beside it. */
  cacheDir: string;
  /** Recorded in the best-effort, diagnostics-only status file — never the exclusion mechanism. */
  pid?: number;
  version?: string;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Fires after every acquisition attempt with whether it succeeded — observes retry cadence
   *  without sleeping out the real jitter window. */
  onAttempt?: (acquired: boolean) => void;
  /** CLOSE_PROMOTION_RACE/LOCK_TXN_LOSS/LOCK_FILE_REPLACEMENT: fires with the raw lock `Database`
   *  the instant an acquisition succeeds, before promote/keepalive bookkeeping runs. */
  onAcquire?: (db: Database) => void;
  /** LOCK_TXN_LOSS/LOCK_FILE_REPLACEMENT: fires with the reason on every keepalive-detected
   *  demotion. Production demotion is logged to stderr instead (see `demote` below). */
  onDemote?: (reason: string) => void;
  /** Overrides `KEEPALIVE_MS` for tests. */
  keepaliveMs?: number;
  /** Overrides the lock connection open — injects a non-busy OPEN failure (ENOSPC/EACCES/corrupt file, F4). */
  openLockDb?: (cacheDir: string) => Promise<Database>;
  /** Overrides the dev+inode identity check both `promote()` (F5) and the keepalive tick
   *  (LOCK_FILE_REPLACEMENT) use — injects a stat failure or a mismatched identity. */
  statIdentity?: (path: string) => FileIdentity | undefined;
  /** CI fix: overrides the keepalive tick's scheduler (default: real unref'd `setTimeout`). */
  keepaliveScheduler?: (fn: () => void, ms: number) => { clear: () => void };
}

export interface VaultLeaderElection {
  isLeader(): boolean;
  /** Fires on EVERY promotion, first and every re-acquisition after a demote (F2) — never
   *  spliced-off, so a promote→demote→re-promote cycle still runs the catch-up reconcile. */
  onPromote(cb: () => void): void;
  /** Fires on every keepalive-detected demotion (F1); AWAITED before the lock releases, so this
   *  process's own writes stop before a challenger can start its own. */
  onDemote(cb: (reason: string) => Promise<void> | void): void;
  /** F4: the most recent NON-BUSY error a follower's retry hit — health.ts reads this. */
  getLastFollowerError(): LockErrorInfo | undefined;
  /** Idempotent. Stops any pending retry timer and, if leader, rolls back + closes the lock
   *  connection so the OS releases it immediately rather than at process exit. */
  close(): Promise<void>;
}

function jitter(minMs: number, maxMs: number): number {
  return minMs + Math.random() * Math.max(0, maxMs - minMs);
}

function isBusyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "SQLITE_BUSY") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY/i.test(msg);
}

/**
 * One acquisition attempt: opens a FRESH connection and tries to take + hold `BEGIN EXCLUSIVE`
 * non-blocking. Returns the open `Database` on success, `undefined` on contention. Any OTHER error
 * (disk full, corrupt lock file) propagates.
 *
 * COLD_BOOT_PRELOCK: the open itself is NOT `busy_timeout=0`. `openDatabase` converts a brand-new
 * file to WAL as part of opening it, which needs a brief EXCLUSIVE lock — two processes racing the
 * same fresh file with `busy_timeout=0` threw `SQLITE_BUSY` straight out of `openDatabase`,
 * unhandled. `DEFAULT_BUSY_TIMEOUT_MS` lets that pragma wait out a concurrent converter instead;
 * the connection then switches to non-blocking right before the actual election attempt below.
 */
async function tryAcquire(
  cacheDir: string,
  openLockDb: (cacheDir: string) => Promise<Database>,
): Promise<Database | undefined> {
  let db: Database;
  try {
    db = await openLockDb(cacheDir);
  } catch (err) {
    // Busy-shaped failure at OPEN time is the WAL-conversion race above — classify like a busy
    // BEGIN EXCLUSIVE so a follower retries instead of crashing on real contention.
    if (isBusyError(err)) return undefined;
    throw err;
  }
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    return db;
  } catch (err) {
    try {
      db.close?.();
    } catch {}
    if (isBusyError(err)) return undefined;
    throw err;
  }
}

function writeStatusFile(
  cacheDir: string,
  info: { pid: number; startedAt: string; version: string },
): void {
  try {
    writeFileSync(join(cacheDir, STATUS_FILE_NAME), `${JSON.stringify(info, null, 2)}\n`, "utf8");
  } catch {
    // Diagnostics-only, best-effort — never the exclusion mechanism.
  }
}

/**
 * Starts (or joins) this vault's leader election. Resolves once the FIRST acquisition attempt has
 * settled: leader immediately, or a follower with a retry timer already scheduled (unref'd).
 */
export async function startVaultLeaderElection(
  opts: VaultLeaderElectionOptions,
): Promise<VaultLeaderElection> {
  const retryMinMs = opts.retryMinMs ?? DEFAULT_RETRY_MIN_MS;
  const retryMaxMs = opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const pid = opts.pid ?? process.pid;
  const version = opts.version ?? "unknown";
  const keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS;
  const lockPath = join(opts.cacheDir, LOCK_FILE_NAME);
  const openLockDb =
    opts.openLockDb ??
    ((dir: string) => openDatabase(join(dir, LOCK_FILE_NAME), DEFAULT_BUSY_TIMEOUT_MS));
  const statFn = opts.statIdentity ?? statIdentity;
  const keepaliveScheduler: (fn: () => void, ms: number) => { clear: () => void } =
    opts.keepaliveScheduler ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { clear: () => clearTimeout(t) };
    });

  let lockDb: Database | undefined; // strong ref for the GC trap (header); set on promotion
  let heldIdentity: FileIdentity | undefined; // dev+inode `lockDb` opened against, for keepalive
  let leader = false;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveHandle: { clear: () => void } | undefined;
  const promoteCallbacks: Array<() => void> = [];
  const demoteCallbacks: Array<(reason: string) => Promise<void> | void> = [];
  let identityMismatchStreak = 0; // F5: a mismatch must reproduce on the NEXT tick too (see below)
  let lastFollowerError: LockErrorInfo | undefined; // F4: surfaced via health.ts

  // Best-effort: a plain ROLLBACK against an already-autocommit or file-replaced connection is
  // harmless either way.
  const releaseLockDb = (): void => {
    if (!lockDb) return;
    try {
      lockDb.exec("ROLLBACK");
    } catch {}
    try {
      lockDb.close?.();
    } catch {}
    lockDb = undefined;
    heldIdentity = undefined;
  };

  // STALE_ROLE_AFTER_CLOSE / LOCK_TXN_LOSS / LOCK_FILE_REPLACEMENT: the ONE place `leader` flips
  // false once this process no longer holds the OS-level lock. F1: async — awaits every `onDemote`
  // callback BEFORE releasing, so this process's own writes stop before a challenger can start.
  const demote = async (reason: string): Promise<void> => {
    const wasLeader = leader;
    leader = false;
    identityMismatchStreak = 0;
    keepaliveHandle?.clear();
    keepaliveHandle = undefined;
    if (wasLeader) {
      process.stderr.write(`[leader] demoted: ${reason}\n`);
      opts.onDemote?.(reason);
      for (const cb of demoteCallbacks) {
        try {
          await cb(reason);
        } catch (err) {
          process.stderr.write(
            `[leader] demote hook failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
    releaseLockDb();
    if (!closed) scheduleRetry();
  };

  const scheduleKeepalive = (): void => {
    keepaliveHandle = keepaliveScheduler(() => {
      // Read THROUGH the connection, not just close over it — see GC trap header.
      if (lockDb) {
        // LOCK_TXN_LOSS: SQLite auto-rolls-back an open transaction on IOERR/FULL/NOMEM/BUSY/
        // INTERRUPT. Absent probe (unshipped adapter) reads "can't tell", never "lost".
        let stillInTransaction: boolean | undefined;
        try {
          stillInTransaction = lockDb.inTransaction?.();
        } catch {
          stillInTransaction = undefined;
        }
        if (stillInTransaction === false) {
          void demote("lock transaction is no longer open (SQLite auto-rollback)");
          return;
        }
        // LOCK_FILE_REPLACEMENT: an external replace leaves this fd on the OLD file. F5: a mismatch
        // must reproduce on TWO CONSECUTIVE ticks — a single glitch demoted a still-live leader.
        if (heldIdentity) {
          const current = statFn(lockPath);
          const mismatch =
            !current || current.dev !== heldIdentity.dev || current.ino !== heldIdentity.ino;
          if (mismatch) {
            identityMismatchStreak += 1;
            if (identityMismatchStreak >= 2) {
              void demote("lock file at cacheDir was replaced (dev/inode mismatch)");
              return;
            }
          } else {
            identityMismatchStreak = 0;
          }
        }
        try {
          void lockDb.prepare("SELECT 1").get();
        } catch {}
      }
      if (!closed) scheduleKeepalive();
    }, keepaliveMs);
  };

  const promote = (db: Database): void => {
    // F5: if `stat` on the just-acquired lock file fails, `heldIdentity` would stay undefined
    // forever and the replacement check could never detect a second holder. Release and retry.
    const identity = statFn(lockPath);
    if (!identity) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      try {
        db.close?.();
      } catch {}
      if (!closed) scheduleRetry();
      return;
    }
    lockDb = db;
    heldIdentity = identity;
    identityMismatchStreak = 0;
    leader = true;
    writeStatusFile(opts.cacheDir, { pid, startedAt: new Date().toISOString(), version });
    scheduleKeepalive();
    // F2: iterate WITHOUT consuming — must fire on EVERY promotion, not just the first.
    for (const cb of promoteCallbacks) cb();
  };

  const scheduleRetry = (): void => {
    if (closed) return;
    retryTimer = setTimeout(
      () => {
        void (async () => {
          if (closed) return;
          let acquired: Database | undefined;
          try {
            acquired = await tryAcquire(opts.cacheDir, openLockDb);
          } catch (err) {
            // F4: classify rather than swallow. Non-busy errors are surfaced instead of vanishing.
            if (!isBusyError(err)) {
              const code = (err as { code?: string } | null)?.code;
              const message = err instanceof Error ? err.message : String(err);
              lastFollowerError = {
                message,
                code,
                count: (lastFollowerError?.count ?? 0) + 1,
                lastAt: new Date().toISOString(),
              };
              process.stderr.write(
                `[leader] follower retry failed (non-busy, count=${lastFollowerError.count}): ${code ? `${code}: ` : ""}${message}\n`,
              );
            }
          }
          if (acquired) opts.onAcquire?.(acquired);
          // CLOSE_PROMOTION_RACE: recheck `closed` AFTER the await — a stale pre-await check let an
          // already-closed follower promote anyway, blocking every future challenger.
          opts.onAttempt?.(acquired !== undefined);
          if (closed) {
            if (acquired) {
              try {
                acquired.exec("ROLLBACK");
              } catch {}
              try {
                acquired.close?.();
              } catch {}
            }
            return;
          }
          if (acquired) {
            promote(acquired);
          } else {
            scheduleRetry();
          }
        })();
      },
      jitter(retryMinMs, retryMaxMs),
    );
    retryTimer.unref?.();
  };

  const initial = await tryAcquire(opts.cacheDir, openLockDb);
  if (initial) opts.onAcquire?.(initial);
  opts.onAttempt?.(initial !== undefined);
  if (initial) {
    promote(initial);
  } else {
    scheduleRetry();
  }

  return {
    isLeader: () => leader,
    onPromote: (cb: () => void): void => {
      promoteCallbacks.push(cb);
    },
    onDemote: (cb: (reason: string) => Promise<void> | void): void => {
      demoteCallbacks.push(cb);
    },
    getLastFollowerError: () => lastFollowerError,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      // STALE_ROLE_AFTER_CLOSE: flip the reported role BEFORE releasing SQLite — no `await`
      // precedes this, so any `isLeader()` read the instant `close()` is invoked sees `false`.
      leader = false;
      if (retryTimer) clearTimeout(retryTimer);
      keepaliveHandle?.clear();
      keepaliveHandle = undefined;
      releaseLockDb();
    },
  };
}

/**
 * COLD_BOOT_PRELOCK: serializes `fn` (real caller: `wireStores`'s migration pass) across every
 * process racing the SAME `cacheDir` on a fresh boot, BEFORE the leader election below runs — two
 * processes opening a brand-new `cache.db` at once previously raced each other's migration runner
 * directly. Uses its OWN file (`BOOTSTRAP_BARRIER_FILE_NAME`), never `vault-lock.db` — see that
 * constant's doc comment for the deadlock sharing one file produced.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Jittered backoff for `openBarrierConnectionWithRetry` — tighter than the election's 5-15s: this
 *  loop only needs to survive a brand-new file's one-time WAL conversion. */
const BARRIER_OPEN_RETRY_MIN_MS = 50;
const BARRIER_OPEN_RETRY_MAX_MS = 150;

/** COLD_BOOT_PRELOCK: opens the barrier file with the same busy-shaped-open retry `tryAcquire`
 *  needs, bounded by `BOOTSTRAP_BARRIER_TIMEOUT_MS` so a stuck contender still fails loudly. */
async function openBarrierConnectionWithRetry(cacheDir: string): Promise<Database> {
  const deadline = Date.now() + BOOTSTRAP_BARRIER_TIMEOUT_MS;
  for (;;) {
    try {
      return await openDatabase(
        join(cacheDir, BOOTSTRAP_BARRIER_FILE_NAME),
        BOOTSTRAP_BARRIER_TIMEOUT_MS,
      );
    } catch (err) {
      if (!isBusyError(err) || Date.now() >= deadline) throw err;
      await sleep(jitter(BARRIER_OPEN_RETRY_MIN_MS, BARRIER_OPEN_RETRY_MAX_MS));
    }
  }
}

export async function withBootstrapBarrier<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(cacheDir, { recursive: true });
  const db = await openBarrierConnectionWithRetry(cacheDir);
  try {
    db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
    db.exec("COMMIT");
    return result;
  } finally {
    try {
      db.close?.();
    } catch {}
  }
}

// Wraps `runReconcileRaw` (`runtime/plane-wiring.ts`) so it only runs on the leader, and wires
// `election.onPromote` to fire ONE reconcile immediately on promotion rather than waiting for the
// scheduler's next tick. Returning ONE wrapped function (vs. gating boot's `start()` and
// scheduler-wiring's periodic job separately) means a caller cannot wire one and forget the other.
// SHUTDOWN_RECONCILE_OVERLAP: `currentRun()` lets `close()` JOIN a still-running reconcile before
// releasing the leader lock.
export interface GatedReconcile {
  (signal: AbortSignal): Promise<void>;
  currentRun(): Promise<void> | undefined;
}

/** F1: bound for the onDemote join below — shorter than shutdown's SHUTDOWN_DRAIN_MS since this
 *  process is not exiting, just giving up leadership. */
const DEFAULT_DEMOTE_JOIN_DEADLINE_MS = 3_000;

export function gateReconcileByLeader(
  election: VaultLeaderElection,
  runReconcileRaw: (signal: AbortSignal) => Promise<void>,
  abort: { signal: AbortSignal },
  opts: { demoteJoinDeadlineMs?: number } = {},
): GatedReconcile {
  // Runs OUTSIDE the scheduler's own single-flight tracking — without a guard, a follower
  // promoting mid-reconcile would start a SECOND concurrent pass over every vault. One shared
  // in-flight promise, joined by every caller regardless of who started it, closes that gap.
  let inFlight: Promise<void> | undefined;
  // F1: per-run AbortController chained to the outer signal, never that signal directly — it is
  // one-shot and would leave later re-promotions unable to ever reconcile again.
  let runAbort: AbortController | undefined;
  const gated = (async (signal: AbortSignal): Promise<void> => {
    if (!election.isLeader()) return;
    if (inFlight) return inFlight;
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    runAbort = controller;
    const run = runReconcileRaw(controller.signal).finally(() => {
      signal.removeEventListener("abort", forwardAbort);
      if (inFlight === run) inFlight = undefined;
      if (runAbort === controller) runAbort = undefined;
    });
    inFlight = run;
    return run;
  }) as GatedReconcile;
  gated.currentRun = () => inFlight;
  election.onPromote(() => {
    void gated(abort.signal).catch((err) => {
      process.stderr.write(
        `[leader] reconcile after promotion failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  });
  // F1: on demote, abort THIS run's signal (never the shared outer one) and join it bounded.
  election.onDemote(async () => {
    if (!inFlight) return;
    runAbort?.abort();
    await joinInFlightReconcile(
      inFlight,
      opts.demoteJoinDeadlineMs ?? DEFAULT_DEMOTE_JOIN_DEADLINE_MS,
    );
  });
  return gated;
}
