// GH #995: per-vault (really per-cacheDir — the same granularity cache.db already uses; see
// stores.ts's `openDatabase(join(deps.cacheDir, "cache.db"), ...)`) indexing LEADER LOCK. When
// several MCP clients spawn separate stdio processes against the SAME vault config, every process
// previously ran its own boot reconcile/embed pass AND its own watcher-driven index writes
// concurrently — an N-times CPU storm and a genuine multi-writer race on one shared cache.db (the
// Serena-class corruption risk; see
// /home/ubuntu/src/research/obsidian-tc-shared-instance-2026-09-28/{00-recommendation,02-primitives}.md).
//
// This module elects exactly ONE of those processes "leader": the one holding an UNCOMMITTED
// `BEGIN EXCLUSIVE` transaction open on a small side SQLite file next to cache.db
// (`vault-lock.db`). Followers retry on a jittered timer and promote the moment the leader's
// transaction is released — which happens automatically on ANY holder exit, including SIGKILL,
// because `BEGIN EXCLUSIVE` is a real OS-level lock under SQLite's own hood (POSIX advisory /
// Win32 LockFileEx), not application state that needs a stale-timeout policy. `PRAGMA
// busy_timeout=0` on the acquiring connection makes contention fail IMMEDIATELY — "busy" here
// means "someone else is leader", never "wait your turn".
//
// THE GC TRAP (read before touching this file). A `bun:sqlite` `Database` with no reachable JS
// reference is finalized by Bun's GC — and the finalizer CLOSES the native connection, silently
// releasing the lock out from under a still-running leader. Measured directly (Bun 1.4.2, SQLite
// 3.53.2): a holder that keeps a STRONG reference to its `Database` (and a closure that actually
// USES it, not merely captures it — JSC drops an unused capture) stays leader through repeated
// forced `Bun.gc(true)`; a holder with no live reference lets a challenger ACQUIRE within one GC
// cycle (~0.3s), no crash, no error, nothing to grep for. test/vault-lock-gc-trap.test.ts pins
// this against the REAL module below (Bun only — the trap is Bun-specific).
//
// Why `openDatabase` (this repo's existing bun-sqlite.ts / node-better-sqlite3.ts /
// node-node-sqlite.ts split) rather than a bespoke connection: its returned `Database` port's
// `close`/`exec`/`prepare` methods are CLOSURES over the native handle, so holding the RETURNED
// PORT OBJECT alive already keeps the native handle reachable through that closure — no separate
// "pin" object is needed on top. This module stores that port on the `VaultLeaderElection` it
// returns (see `lockDb` below), which the caller keeps referenced for the whole runtime's
// lifetime, and additionally runs a keepalive tick that reads through the connection (not just
// captures it) belt-and-braces against the trap above.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/open";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../db/pragmas";
import type { Database } from "../db/types";
// F1 (fix round 2): reuse the SAME bounded-join primitive close()'s own SHUTDOWN_RECONCILE_OVERLAP
// fix uses, rather than re-implementing a second race-against-a-timer here.
import { joinInFlightReconcile } from "./shutdown-phase";

// Exported (fix round, GH #995): tests assert against the literal path this module actually uses.
export const LOCK_FILE_NAME = "vault-lock.db";
const STATUS_FILE_NAME = "vault-lock.status.json";
/** COLD_BOOT_PRELOCK (fix round): withBootstrapBarrier's OWN file, deliberately NOT vault-lock.db.
 *  The barrier's `BEGIN IMMEDIATE` is transient (released the instant `fn()` returns); the leader
 *  election's `BEGIN EXCLUSIVE` on vault-lock.db is held for the process's whole lifetime. Sharing
 *  one file was tried and DEADLOCKED: the moment the barrier's winner becomes leader, it holds
 *  vault-lock.db's EXCLUSIVE lock forever, and a loser still waiting on ITS OWN barrier acquire
 *  (busy-retrying a `BEGIN IMMEDIATE` on the SAME file) then blocks for the full busy_timeout with
 *  no way to ever succeed — a permanent lock defeating a transient one contending on one file. */
const BOOTSTRAP_BARRIER_FILE_NAME = "vault-lock-bootstrap.db";

/** Follower retry jitter window per the design doc (5-15s). */
export const DEFAULT_RETRY_MIN_MS = 5000;
export const DEFAULT_RETRY_MAX_MS = 15000;

/** How often a leader's keepalive tick reads through its own lock connection — see this file's GC
 *  trap header. Cheap (a single in-transaction `SELECT 1`), and only ever scheduled for a leader.
 *  Also where the fix-round LOCK_TXN_LOSS/LOCK_FILE_REPLACEMENT checks run (see `scheduleKeepalive`
 *  below) — overridable via `keepaliveMs` so a test can observe demotion without waiting out the
 *  production interval. */
const KEEPALIVE_MS = 1000;

/** Bounded wait for `withBootstrapBarrier`'s blocking `BEGIN IMMEDIATE` — long enough to sit behind
 *  a genuinely slow concurrent migration pass, short enough that a truly stuck holder still fails
 *  boot loudly rather than hanging forever. */
const BOOTSTRAP_BARRIER_TIMEOUT_MS = 60_000;

/** dev+inode identity of a stat'd file — LOCK_FILE_REPLACEMENT's mismatch check compares this
 *  against a fresh stat of the same PATH on every keepalive tick. */
interface FileIdentity {
  dev: number;
  ino: number;
}

function statIdentity(path: string): FileIdentity | undefined {
  try {
    const s = statSync(path);
    return { dev: s.dev, ino: s.ino };
  } catch {
    return undefined; // gone entirely — also a mismatch, handled by the caller
  }
}

/** F4 (fix round 2): a follower's most recent NON-BUSY acquisition failure — busy (someone else is
 *  leader) is the expected steady state and never populates this. `count` is cumulative across the
 *  life of the election, so a caller can tell "still failing" from "failed once, long ago". */
export interface LockErrorInfo {
  message: string;
  code?: string;
  count: number;
  lastAt: string;
}

export interface VaultLeaderElectionOptions {
  /** Same directory cache.db lives in — the lock file sits beside it. */
  cacheDir: string;
  /** Recorded in the (best-effort, diagnostics-ONLY — never the exclusion mechanism) status file. */
  pid?: number;
  version?: string;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Test hook: fires after every acquisition attempt (leader or follower) with whether it
   *  succeeded, before scheduling the next retry — lets a test observe retry cadence without
   *  sleeping out the real jitter window. Never called by production callers. */
  onAttempt?: (acquired: boolean) => void;
  /** Test hook (fix round, CLOSE_PROMOTION_RACE/LOCK_TXN_LOSS/LOCK_FILE_REPLACEMENT): fires with
   *  the raw lock `Database` the instant an acquisition succeeds, before this module's own
   *  bookkeeping (promote/keepalive) runs — lets a test race `close()` against promotion, or
   *  simulate a lost transaction on the SAME connection the module holds. Never called by
   *  production callers. */
  onAcquire?: (db: Database) => void;
  /** Test hook (fix round, LOCK_TXN_LOSS/LOCK_FILE_REPLACEMENT): fires with the reason string every
   *  time the keepalive tick demotes a leader. Never called by production callers — production
   *  demotion is logged to stderr instead (see `demote` below). */
  onDemote?: (reason: string) => void;
  /** Overrides `KEEPALIVE_MS` — production never sets this; tests use it to observe a demotion
   *  without waiting out the real 1s interval. */
  keepaliveMs?: number;
  /** Test-only override for opening the lock connection (`tryAcquire`'s `openDatabase` call).
   *  Lets a test inject a non-busy OPEN failure (ENOSPC/EACCES/corrupt file — F4) without touching
   *  the cacheDir or lock file another connection in the SAME process still has open, which a real
   *  unlink/rmdir cannot do on Windows (an open file/its parent directory cannot be removed there
   *  — see vault-lock.test.ts's F4 case). Defaults to the real `openDatabase` against
   *  `LOCK_FILE_NAME` under `cacheDir`. Never set by production callers. */
  openLockDb?: (cacheDir: string) => Promise<Database>;
  /** Test-only override for the dev+inode identity check both `promote()` (post-acquire, F5) and
   *  the keepalive tick (LOCK_FILE_REPLACEMENT) use. Lets a test inject a stat failure or a
   *  mismatched identity without unlinking/replacing a file this SAME process still has open,
   *  which a real unlink/replace cannot do on Windows either (same constraint as `openLockDb`
   *  above). Defaults to a real `statSync`-based dev+inode read. Never set by production callers. */
  statIdentity?: (path: string) => FileIdentity | undefined;
}

export interface VaultLeaderElection {
  isLeader(): boolean;
  /** Registers a callback that fires on EVERY promotion, first and every re-acquisition after a
   *  demote (fix round 2, F2) — never spliced-off after one firing, so a promote→demote→re-promote
   *  cycle still runs the catch-up reconcile (periodic reconcile is off by default). Never fires
   *  for a process that started as leader. */
  onPromote(cb: () => void): void;
  /** Registers a callback that fires on every keepalive-detected demotion (fix round 2, F1), never
   *  on `close()` (its own abort→join→release sequence lives in server-runtime.ts). `demote()`
   *  AWAITS every registered callback in order BEFORE releasing the lock, so a callback that stops
   *  this process's own writes actually finishes before a challenger can start its own. A callback
   *  that throws is logged and does not block the others or the release that follows. */
  onDemote(cb: (reason: string) => Promise<void> | void): void;
  /** F4 (fix round 2): the most recent NON-BUSY error a follower's retry hit (undefined if none
   *  ever happened, or only busy contention so far) — health.ts's leader_role_detail reads this. */
  getLastFollowerError(): LockErrorInfo | undefined;
  /** Idempotent. Stops any pending retry timer and, if leader, rolls back + closes the lock
   *  connection so the OS releases it immediately rather than waiting for process exit — the
   *  bounded-shutdown deadline (#997, runtime/shutdown-phase.ts) this runs inside of does not
   *  depend on it, but a prompt release lets a waiting follower promote sooner. */
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
 * non-blocking. Returns the open `Database` (transaction held) on success, `undefined` on
 * contention. Any OTHER error (disk full, corrupt lock file) propagates — a non-busy failure to
 * even open the lock file must not silently read as "just a follower".
 *
 * COLD_BOOT_PRELOCK (fix round 2): the open itself is NOT `busy_timeout=0`. `openDatabase`'s own
 * connectionPragmas() convert a brand-new file to WAL as part of opening it (db/pragmas.ts — the
 * order is load-bearing, `busy_timeout` first), and that conversion needs a brief EXCLUSIVE lock.
 * Two processes racing the SAME fresh lock file previously both opened with `busy_timeout=0`, so
 * the loser's WAL-conversion pragma threw `SQLITE_BUSY`/"database is locked" straight out of
 * `openDatabase` — OUTSIDE this function's try/catch, unhandled, ~3/8 runs of the
 * COLD_BOOT_PRELOCK integration test. Opening with `DEFAULT_BUSY_TIMEOUT_MS` instead lets that
 * pragma wait out a concurrent converter exactly like every other connection in this repo; the
 * connection is then switched to non-blocking (`busy_timeout=0`) right before the actual election
 * attempt below, so lock CONTENTION (as opposed to the one-time WAL conversion) still fails
 * immediately — see this file's header on why "busy" here means "someone else is leader".
 *
 * `openLockDb` is production's real open (`opts.openLockDb ?? defaultOpenLockDb` below) unless a
 * test overrides it — see `VaultLeaderElectionOptions.openLockDb`'s own doc comment (F4).
 */
async function tryAcquire(
  cacheDir: string,
  openLockDb: (cacheDir: string) => Promise<Database>,
): Promise<Database | undefined> {
  let db: Database;
  try {
    db = await openLockDb(cacheDir);
  } catch (err) {
    // A busy-shaped failure at OPEN time is the WAL-conversion race above, not a lock-file
    // problem — classify it the same as a busy BEGIN EXCLUSIVE so a follower retries instead of
    // this election crashing outright on what is really contention.
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
    } catch {
      // best-effort: this connection never held the lock, nothing to release
    }
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
    // Diagnostics-only, best-effort — see this file's header on why status is never the exclusion
    // mechanism (a real SQL row inside the held EXCLUSIVE transaction would be unreadable by any
    // OTHER connection for the leader's entire lifetime, which would defeat the diagnostic point).
  }
}

/**
 * Starts (or joins) this vault's leader election. Resolves once the FIRST acquisition attempt has
 * settled: either this process is leader immediately, or it is a follower with a retry timer
 * already scheduled (unref'd — it never keeps the process alive on its own, matching the repo's
 * other background timers, e.g. the scheduler).
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

  // Strong references, held for the life of the returned VaultLeaderElection — see this file's GC
  // trap header. `lockDb` is undefined for a follower and set exactly once, on promotion (and
  // cleared again on close()/demotion).
  let lockDb: Database | undefined;
  // The dev+inode this leader's `lockDb` was actually opened against — LOCK_FILE_REPLACEMENT's
  // keepalive check compares a fresh stat of `lockPath` to this on every tick.
  let heldIdentity: FileIdentity | undefined;
  let leader = false;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  const promoteCallbacks: Array<() => void> = [];
  // F1 (fix round 2): fired and AWAITED by demote() before it releases the lock connection and
  // retries — see the VaultLeaderElection.onDemote doc above.
  const demoteCallbacks: Array<(reason: string) => Promise<void> | void> = [];
  // F5 (fix round 2): a mismatch/gone stat at ONE keepalive tick can be transient (a concurrent
  // writer replacing the file in two steps, a momentarily-failed stat) — require it to reproduce
  // on the NEXT tick too before demoting a leader that may still genuinely hold the lock.
  let identityMismatchStreak = 0;
  // F4 (fix round 2): a follower's retry previously swallowed EVERY non-busy error identically to
  // a busy one — silent forever if the lock file becomes unopenable (ENOSPC/EACCES/corrupt).
  // Tracked here so a caller (server-runtime.ts's health wiring) can surface it without this
  // module depending on the metrics/health modules.
  let lastFollowerError: LockErrorInfo | undefined;

  /** Best-effort release of `lockDb` without assuming its transaction is still open — a plain
   *  ROLLBACK against an already-autocommit connection (LOCK_TXN_LOSS) or a connection whose file
   *  was replaced out from under it (LOCK_FILE_REPLACEMENT) is harmless either way. */
  const releaseLockDb = (): void => {
    if (!lockDb) return;
    try {
      lockDb.exec("ROLLBACK");
    } catch {
      // best-effort: releasing promptly is the goal, not a clean ROLLBACK reply
    }
    try {
      lockDb.close?.();
    } catch {
      // best-effort
    }
    lockDb = undefined;
    heldIdentity = undefined;
  };

  /** STALE_ROLE_AFTER_CLOSE / LOCK_TXN_LOSS / LOCK_FILE_REPLACEMENT (fix round): the ONE place
   *  `leader` flips back to false once this process is no longer actually holding the OS-level
   *  lock — from close() (an intentional release) or from the keepalive tick discovering the lock
   *  was lost out from under it. `isLeader()` and `gateReconcileByLeader`'s live `election.isLeader()`
   *  read both reflect this the instant it runs, never a stale cached true. */
  /** F1 (fix round 2): async — awaits every `onDemote` callback (abort reconcile, cancel queued
   *  watcher ops, join the run) BEFORE releasing the lock, so this process's own writes actually
   *  stop before a challenger can start its own. `leader` still flips `false` SYNCHRONOUSLY first,
   *  so every `isLeader()` read sees it before any callback has even started running. */
  const demote = async (reason: string): Promise<void> => {
    const wasLeader = leader;
    leader = false;
    identityMismatchStreak = 0;
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
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
    keepaliveTimer = setTimeout(() => {
      // Read THROUGH the connection (not just close over it) — a closure that only captures `db`
      // without using it is dropped by JSC and does not prevent the GC trap (see header).
      if (lockDb) {
        // LOCK_TXN_LOSS: SQLite auto-rolls-back an open transaction on IOERR/FULL/NOMEM/BUSY/
        // INTERRUPT (its own documented behavior), silently returning the connection to
        // autocommit. `inTransaction` is each adapter's live probe (bun:sqlite/better-sqlite3's
        // `.inTransaction`, node:sqlite's `.isTransaction` — see db/types.ts). Absent only on an
        // adapter this repo doesn't ship; a missing probe is treated as "can't tell", never as
        // "lost", so it stays best-effort exactly like the liveness poke below.
        let stillInTransaction: boolean | undefined;
        try {
          stillInTransaction = lockDb.inTransaction?.();
        } catch {
          stillInTransaction = undefined;
        }
        if (stillInTransaction === false) {
          // A lost transaction is a hard, unambiguous signal (SQLite already rolled it back) —
          // demote immediately, no streak needed.
          void demote("lock transaction is no longer open (SQLite auto-rollback)");
          return;
        }
        // LOCK_FILE_REPLACEMENT: compare the PATH's current dev+inode to the one this connection
        // was actually opened against. An external replace/restore (unlink+recreate, or an atomic
        // rename over the same name) leaves this connection's fd pointing at the OLD file while a
        // fresh open of the same path now reaches a DIFFERENT one — two disjoint lock namespaces,
        // both readable as "the lock", which is exactly the two-leaders hazard this guards.
        //
        // F5 (fix round 2): a mismatch (including a transient stat() failure — `!current`) must
        // reproduce on TWO CONSECUTIVE ticks before demoting. A single glitch here previously
        // demoted a still-live leader outright.
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
        } catch {
          // best-effort liveness poke; a real failure here surfaces via the next real operation
        }
      }
      if (!closed) scheduleKeepalive();
    }, keepaliveMs);
    keepaliveTimer.unref?.();
  };

  const promote = (db: Database): void => {
    // F5 (fix round 2): if `stat` on the just-acquired lock file fails (ENOENT — raced against an
    // external unlink between BEGIN EXCLUSIVE and this stat), the replacement check below would
    // never run at all (`heldIdentity` stays undefined forever), so this process could hold the
    // lock while a second process ALSO holds it against a different inode at the same path with
    // no detection for the rest of its life. Release and retry rather than become leader blind.
    const identity = statFn(lockPath);
    if (!identity) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best-effort: this connection never became `lockDb`, nothing else references it
      }
      try {
        db.close?.();
      } catch {
        // best-effort
      }
      if (!closed) scheduleRetry();
      return;
    }
    lockDb = db;
    heldIdentity = identity;
    identityMismatchStreak = 0;
    leader = true;
    writeStatusFile(opts.cacheDir, { pid, startedAt: new Date().toISOString(), version });
    scheduleKeepalive();
    // F2 (fix round 2): iterate WITHOUT consuming — a callback registered once must fire on EVERY
    // promotion (first AND every re-promotion after a demote), not just the first. Previously
    // `splice(0)` drained the list, so a follower that promoted, demoted, and re-promoted ran its
    // second promotion with an empty list — the catch-up reconcile this wires (see
    // `gateReconcileByLeader` below) never ran for whatever the process missed while demoted.
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
            // F4 (fix round 2): classify rather than swallow. A busy-shaped failure is the
            // expected steady state (someone else is leader) and stays silent, exactly as before.
            // Anything else (ENOSPC, EACCES, a corrupt lock file) previously vanished identically
            // — no log, no counter — so a follower could retry forever with zero visibility into
            // WHY no leader was ever elected. Retry cadence is unchanged either way (the same
            // jittered backoff below); this only adds observability.
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
          // CLOSE_PROMOTION_RACE (fix round): recheck `closed` AFTER the await, not just before it
          // — close() can run while this attempt is in flight. A stale check before the await let
          // an already-closed follower promote anyway (leader=true with a lock nothing intends to
          // hold), leaving the transaction open and every future challenger BLOCKED against a
          // process that reports itself closed.
          opts.onAttempt?.(acquired !== undefined);
          if (closed) {
            if (acquired) {
              try {
                acquired.exec("ROLLBACK");
              } catch {
                // best-effort: this connection never became `lockDb`, nothing else references it
              }
              try {
                acquired.close?.();
              } catch {
                // best-effort
              }
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
      // STALE_ROLE_AFTER_CLOSE (fix round): flip the reported role BEFORE releasing SQLite, not
      // after — this function has no `await` before this point, so any caller reading
      // `isLeader()` (directly, or through `gateReconcileByLeader`'s live check) the instant
      // `close()` is invoked sees `false`, never a window where SQLite is already released but
      // this election still claims leadership.
      leader = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (keepaliveTimer) clearTimeout(keepaliveTimer);
      releaseLockDb();
    },
  };
}

/**
 * COLD_BOOT_PRELOCK (fix round): serializes `fn` (real callers: `wireStores`'s migration pass)
 * across every process racing the SAME `cacheDir` on a fresh boot, BEFORE the non-blocking leader
 * election below ever runs. Two real processes opening a brand-new `cache.db` at once previously
 * raced each other's migration runner directly (`migration 20260820_001 failed: duplicate column
 * name: scope_caller` — reproduced with two real built CLIs, see the PR description), because
 * nothing serialized that step ahead of election.
 *
 * Uses its OWN file (`BOOTSTRAP_BARRIER_FILE_NAME`), never `vault-lock.db` — see that constant's
 * doc comment for the deadlock sharing one file produced. A bounded BLOCKING acquire (`BEGIN
 * IMMEDIATE` under a real `busy_timeout`, not the election's `busy_timeout=0` fail-immediately
 * mode): SQLite's busy handler does the retry-until-timeout internally, no app-level poll loop
 * needed. The barrier connection is opened, used, and closed within this call; by the time
 * `startVaultLeaderElection` runs afterward there is nothing left for it to contend with beyond its
 * own peers' elections.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Jittered backoff window for `openBarrierConnectionWithRetry`'s app-level retry — deliberately
 *  much tighter than the election's 5-15s (DEFAULT_RETRY_MIN_MS/MAX_MS): this loop only needs to
 *  survive a brand-new file's one-time WAL conversion, not steady-state leader contention. */
const BARRIER_OPEN_RETRY_MIN_MS = 50;
const BARRIER_OPEN_RETRY_MAX_MS = 150;

/**
 * COLD_BOOT_PRELOCK (fix round 2): opens the barrier file itself with the same busy-shaped-open
 * retry `tryAcquire` needed — belt-and-braces alongside the non-zero `busy_timeout` already passed
 * to `openDatabase` below (which should make SQLite's own busy handler wait out the WAL-conversion
 * race on a brand-new barrier file). Bounded by the SAME `BOOTSTRAP_BARRIER_TIMEOUT_MS` deadline
 * the blocking `BEGIN IMMEDIATE` after this respects, so a genuinely stuck contender still fails
 * loudly rather than retrying forever.
 */
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
      } catch {
        // best-effort — the real error from fn() is what propagates below
      }
      throw err;
    }
    db.exec("COMMIT");
    return result;
  } finally {
    try {
      db.close?.();
    } catch {
      // best-effort
    }
  }
}

/**
 * GH #995: wraps `runReconcileRaw` (createReconcileRunner's output, `runtime/plane-wiring.ts`) so
 * it only actually runs on the leader, and wires `election.onPromote` to fire ONE reconcile
 * immediately on promotion (through the SAME `AbortSignal` the caller's shutdown path aborts —
 * server-runtime.ts's `bootReconcileAbort`) rather than waiting for the scheduler's next periodic
 * tick. Returning ONE wrapped function, rather than gating each of the two real call sites
 * (server-runtime.ts's boot-time `start()` and scheduler-wiring.ts's periodic "vault-reconcile"
 * job) separately, means a caller cannot wire one and forget the other.
 */
/** A gated reconcile function that ALSO exposes whether a run is currently in flight —
 *  SHUTDOWN_RECONCILE_OVERLAP (fix round): `close()` needs a way to JOIN a still-running reconcile
 *  before releasing the leader lock, rather than the fire-and-forget shape that let a successor
 *  promote and start writing while this process's own reconcile was still mid-walk. */
export interface GatedReconcile {
  (signal: AbortSignal): Promise<void>;
  /** The in-flight run this gate is currently joining, or `undefined` when nothing is running. */
  currentRun(): Promise<void> | undefined;
}

/** F1 (fix round 2): bound for the onDemote join below — shorter than shutdown's
 *  SHUTDOWN_DRAIN_MS since this process is not exiting, just giving up leadership. */
const DEFAULT_DEMOTE_JOIN_DEADLINE_MS = 3_000;

export function gateReconcileByLeader(
  election: VaultLeaderElection,
  runReconcileRaw: (signal: AbortSignal) => Promise<void>,
  abort: { signal: AbortSignal },
  opts: { demoteJoinDeadlineMs?: number } = {},
): GatedReconcile {
  // Self-review (GH #995 follow-up): the promotion-triggered call below runs OUTSIDE the
  // scheduler's own single-flight tracking — scheduler.ts dedupes only ticks IT dispatches for
  // the "vault-reconcile" job slot, and has no visibility into a call this module fires directly
  // off `onPromote`. Without a guard here, a follower promoting while the scheduler's periodic
  // tick (or the boot pass — both routed through this SAME wrapper) is still mid-reconcile would
  // start a SECOND, fully concurrent pass over every vault in ONE process: redundant walk/embed
  // work, and two indexVaultRecorded runs racing each other's content-hash writes — exactly the
  // multi-writer contention this lock exists to prevent, just relocated from cross-process to
  // intra-process. One shared in-flight promise, joined by every caller of `gated` (boot,
  // scheduler tick, promotion) regardless of which one started it, makes this single-flight the
  // same way scheduler.ts's own per-job tracking already is.
  let inFlight: Promise<void> | undefined;
  // F1 (fix round 2): a running reconcile sees a per-run AbortController chained to the outer
  // `abort.signal`, never that signal directly — `abort()` is one-shot, so a demote that aborted
  // the shared shutdown controller would leave later re-promotions unable to ever reconcile again.
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
  // F1 (fix round 2): on demote, abort THIS run's signal (never the shared outer one) and join it
  // bounded — `demote()` awaits this hook, so a challenger cannot start its own reconcile until it
  // resolves.
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
