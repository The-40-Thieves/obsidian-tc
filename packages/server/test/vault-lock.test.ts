// GH #995: unit coverage for the per-vault leader lock (src/runtime/vault-lock.ts) — acquire,
// busy/follower, release, release-on-close, and re-acquire after the holder's process is
// SIGKILLed (a real child process, not a simulated close — proving the OS, not application code,
// releases the lock, per the primitives doc's own measurement). The Bun GC-trap case (a previous
// agent's WRONG "bun:sqlite does not enforce BEGIN EXCLUSIVE across processes" conclusion) is
// covered separately in test/vault-lock-gc-trap.test.ts, which needs Bun's own GC; this file is
// runtime-agnostic (runs under vitest/Node) and exercises the SAME production module, which
// itself routes to bun:sqlite/better-sqlite3/node:sqlite via db/open.ts's existing adapter split.
import { spawn, spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/db/pragmas";
import type { Database } from "../src/db/types";
import {
  gateReconcileByLeader,
  LOCK_FILE_NAME,
  startVaultLeaderElection,
  statIdentity,
  type VaultLeaderElection,
} from "../src/runtime/vault-lock";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOLDER_PROBE = join(HERE, "vault-lock-holder-probe.ts");
// Mirrors param-binding.test.ts / shutdown-boot-embed.test.ts's own guard: bun is expected on
// every dev/CI box here, but skip rather than fail when it's genuinely absent.
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

// Windows CI (GH #998): the F4/F5/LOCK_FILE_REPLACEMENT cases below used to unlink/replace the
// SAME vault-lock.db (or its cacheDir) a live connection in THIS process still had open — Windows
// refuses to delete an open file or a directory containing one (`EPERM ... syscall: 'rm'`), which
// POSIX allows. The behaviour under test (F4's error classification, F5's stat-failure handling,
// the identity-mismatch streak gate) is itself platform-independent, so these inject the failure
// through vault-lock.ts's own test-only `openLockDb`/`statIdentity` seams instead of mutating a
// file another connection in this process still holds — deterministic on every OS, and it never
// touches a real handle at all, closing the Windows gap rather than skipping it.
// CI fix round (fix round, cross-vendor review — windows-latest load-sensitivity, same class GH
// #998 fixed for file I/O): LOCK_FILE_REPLACEMENT and F5's "two consecutive mismatches" case each
// need MULTIPLE consecutive keepalive ticks to fire before they can assert a demotion. A real,
// small `keepaliveMs` timer needing several back-to-back deliveries is exactly the wall-clock
// dependency this repo's other test hooks (`statIdentity`/`openLockDb`) already exist to remove —
// these two tests used to pass real `keepaliveMs` and wait on `setTimeout` delivery, which flaked
// on a CPU-loaded windows-latest runner even with a generous 10s test timeout (GH #998's own fix
// covered the file-I/O half of this same class, not the timer-delivery half). `setImmediate` fires
// on the next macrotask turn regardless of real elapsed time, so a tick fires as fast as the event
// loop allows rather than after `ms` of real wall-clock time.
function deterministicKeepaliveScheduler(fn: () => void, _ms: number): { clear: () => void } {
  let cancelled = false;
  const handle = setImmediate(() => {
    if (!cancelled) fn();
  });
  return {
    clear: () => {
      cancelled = true;
      clearImmediate(handle);
    },
  };
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = makeTempDir("otc-vault-lock-");
  tmpDirs.push(d);
  return d;
}

const elections: VaultLeaderElection[] = [];
function track(e: VaultLeaderElection): VaultLeaderElection {
  elections.push(e);
  return e;
}

// GH #1011 Windows flake: `demote()` intentionally notifies `onDemote` callbacks BEFORE releasing
// the OS-level lock (F1 in vault-lock.ts -- this process's own writes must stop before a
// challenger's can start), so there is a real, platform-timing-dependent gap between "the demote
// callback fired" and "a fresh election can actually acquire." A challenger started the instant a
// demote callback fires can lose that race by a few milliseconds; proven on a real windows-latest
// run (a challenger's own tryAcquire began 1ms before the demoted leader's releaseLockDb() call
// returned). Losing it once is harmless -- but a challenger with no retryMinMs/retryMaxMs override
// then sits on the DEFAULT 5-15s jittered retry, which is what turned that race into a 10s test
// timeout. Waiting on promotion (like "a follower promotes..." below already does) rather than
// asserting synchronous leadership makes the assertion race-free without touching production's
// intentional ordering.
async function waitUntilLeader(election: VaultLeaderElection): Promise<void> {
  if (election.isLeader()) return;
  await new Promise<void>((resolve) => election.onPromote(resolve));
}

afterEach(async () => {
  for (const e of elections.splice(0)) {
    try {
      await e.close();
    } catch {
      // best-effort: the assertion under test has already run either way
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // best-effort
    }
  }
});

describe("vault leader lock (src/runtime/vault-lock.ts)", () => {
  it("acquires the lock when the cacheDir is free", async () => {
    const cacheDir = tmpDir();
    const e = track(await startVaultLeaderElection({ cacheDir }));
    expect(e.isLeader()).toBe(true);
  });

  it("a second election on the SAME cacheDir stays a follower (busy) while the first holds the lock", async () => {
    const cacheDir = tmpDir();
    const a = track(await startVaultLeaderElection({ cacheDir }));
    expect(a.isLeader()).toBe(true);
    const b = track(
      await startVaultLeaderElection({ cacheDir, retryMinMs: 3_600_000, retryMaxMs: 3_600_000 }),
    );
    expect(b.isLeader()).toBe(false);
  });

  it("release on close() lets a FRESH election immediately acquire", async () => {
    const cacheDir = tmpDir();
    const a = await startVaultLeaderElection({ cacheDir });
    expect(a.isLeader()).toBe(true);
    await a.close();
    const c = track(await startVaultLeaderElection({ cacheDir }));
    expect(c.isLeader()).toBe(true);
  });

  it("a follower promotes once the leader closes, inside its own retry window", {
    timeout: stallTimeout(10_000),
  }, async () => {
    const cacheDir = tmpDir();
    const a = await startVaultLeaderElection({ cacheDir });
    expect(a.isLeader()).toBe(true);
    let resolvePromoted!: () => void;
    const promoted = new Promise<void>((resolve) => {
      resolvePromoted = resolve;
    });
    const b = track(await startVaultLeaderElection({ cacheDir, retryMinMs: 20, retryMaxMs: 40 }));
    expect(b.isLeader()).toBe(false);
    b.onPromote(() => resolvePromoted());
    await a.close();
    await promoted;
    expect(b.isLeader()).toBe(true);
  });

  it("onPromote never fires for an election that started as leader", async () => {
    const cacheDir = tmpDir();
    const a = track(await startVaultLeaderElection({ cacheDir }));
    expect(a.isLeader()).toBe(true);
    let fired = false;
    a.onPromote(() => {
      fired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toBe(false);
  });

  // GH #995 fix round: cross-vendor review findings CLOSE_PROMOTION_RACE / STALE_ROLE_AFTER_CLOSE /
  // LOCK_TXN_LOSS / LOCK_FILE_REPLACEMENT.
  it("close() firing while a retry's acquisition is in flight releases the lock and never promotes (CLOSE_PROMOTION_RACE)", async () => {
    const cacheDir = tmpDir();
    const a = await startVaultLeaderElection({ cacheDir });
    expect(a.isLeader()).toBe(true);
    let b!: VaultLeaderElection;
    // onAttempt fires AFTER an acquisition attempt settles (leader or follower); when it fires
    // with acquired=true, b's own promote() has not run yet -- close() here races directly against
    // it. Before the fix, the unconditional `if (acquired) promote(acquired)` below ran anyway,
    // leaving leader=true with an open transaction nothing intends to hold.
    b = await startVaultLeaderElection({
      cacheDir,
      retryMinMs: 10,
      retryMaxMs: 10,
      onAttempt: (acquired) => {
        if (acquired) void b.close();
      },
    });
    await a.close(); // release so b's retry can acquire and race close() as designed above
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(b.isLeader()).toBe(false);
    const challenger = track(await startVaultLeaderElection({ cacheDir }));
    expect(challenger.isLeader()).toBe(true); // the lock must actually be free, not held-and-orphaned
  });

  it("close() reports follower BEFORE the SQLite release completes, and a gate consulting it stops reconciling (STALE_ROLE_AFTER_CLOSE)", async () => {
    const cacheDir = tmpDir();
    const a = track(await startVaultLeaderElection({ cacheDir }));
    expect(a.isLeader()).toBe(true);
    await a.close();
    expect(a.isLeader()).toBe(false);

    let calls = 0;
    const b = track(await startVaultLeaderElection({ cacheDir }));
    const raw = async (): Promise<void> => {
      calls += 1;
    };
    const gated = gateReconcileByLeader(b, raw, { signal: new AbortController().signal });
    await b.close();
    await gated(new AbortController().signal);
    expect(calls).toBe(0); // the gate must consult LIVE state, not a role cached before close()
  });

  it("the keepalive tick demotes when the underlying transaction is no longer open (LOCK_TXN_LOSS)", {
    timeout: stallTimeout(10_000),
  }, async () => {
    const cacheDir = tmpDir();
    let held: Database | undefined;
    let resolveDemoted!: () => void;
    const demoted = new Promise<void>((resolve) => {
      resolveDemoted = resolve;
    });
    const a = track(
      await startVaultLeaderElection({
        cacheDir,
        keepaliveMs: 20,
        // GH #1011: a tight retry window so `a`'s own post-demote follower retry (it keeps
        // contending for this cacheDir after demoting itself) settles well inside this test's own
        // budget instead of sitting on the default 5-15s jittered retry -- see waitUntilLeader's
        // comment above for the full Windows-CI rationale.
        retryMinMs: 20,
        retryMaxMs: 40,
        onAcquire: (db) => {
          held = db;
        },
      }),
    );
    expect(a.isLeader()).toBe(true);
    a.onDemote(() => resolveDemoted());
    // Models SQLite's own documented auto-rollback (IOERR/FULL/NOMEM/BUSY/INTERRUPT can all trigger
    // it): the SAME connection the module holds silently returns to autocommit. From the keepalive
    // tick's point of view this is indistinguishable from the real fault.
    held?.exec("ROLLBACK");
    // Waits for the REAL demote event rather than a fixed wall-clock sleep -- same GH #998
    // Windows-CI rationale as LOCK_FILE_REPLACEMENT/F5 above: a shared, CPU-loaded runner delays
    // queued setTimeout callbacks unpredictably, and this test has the identical fixed-sleep shape.
    await demoted;
    expect(a.isLeader()).toBe(false);
    const challenger = track(
      await startVaultLeaderElection({ cacheDir, retryMinMs: 20, retryMaxMs: 40 }),
    );
    await waitUntilLeader(challenger); // GH #1011 -- see waitUntilLeader's own comment
    expect(challenger.isLeader()).toBe(true);
  });

  it("the keepalive tick demotes when the lock file at cacheDir is replaced by a fresh one (LOCK_FILE_REPLACEMENT)", {
    timeout: stallTimeout(10_000),
  }, async () => {
    const cacheDir = tmpDir();
    // Models an operator restore/cleanup unlinking + recreating vault-lock.db while a holder is
    // still alive -- a distinct dev/inode at the SAME path, so a fresh open reaches a different
    // lock namespace than the one this connection's fd still refers to. Injected via statIdentity
    // (GH #998) rather than actually unlinking the file this connection has open -- see this
    // file's Windows CI note above.
    let statCalls = 0;
    let resolveDemoted!: () => void;
    const demoted = new Promise<void>((resolve) => {
      resolveDemoted = resolve;
    });
    const a = track(
      await startVaultLeaderElection({
        cacheDir,
        keepaliveScheduler: deterministicKeepaliveScheduler,
        // GH #1011: see waitUntilLeader's comment -- keeps `a`'s own post-demote follower retry
        // from sitting on the default 5-15s jittered window.
        retryMinMs: 20,
        retryMaxMs: 40,
        statIdentity: (path) => {
          statCalls += 1;
          const real = statIdentity(path);
          // The FIRST call is promote()'s own post-acquire stat -- it must see the true identity
          // so `a` actually becomes leader. Every call after that is a keepalive tick, which sees
          // a manufactured DIFFERENT inode at the same path forever, exactly like a real replace.
          if (statCalls === 1) return real;
          return real ? { dev: real.dev, ino: real.ino + 1n } : undefined;
        },
      }),
    );
    expect(a.isLeader()).toBe(true);
    a.onDemote(() => resolveDemoted());
    // Waits for the REAL demote event, driven by a DETERMINISTIC keepalive scheduler (CI fix round
    // above) rather than real `setTimeout` delivery -- see that helper's own comment for why.
    await demoted;
    expect(a.isLeader()).toBe(false);
    const challenger = track(
      await startVaultLeaderElection({ cacheDir, retryMinMs: 20, retryMaxMs: 40 }),
    );
    await waitUntilLeader(challenger); // GH #1011 -- see waitUntilLeader's own comment
    expect(challenger.isLeader()).toBe(true);
  });

  // Bun only, deliberately: the holder probe is a raw multi-file TS script with the repo's usual
  // EXTENSIONLESS relative imports (../src/db/open etc, matching every source file in this repo).
  // Bun resolves those directly; plain `node script.ts` does not (Node's ESM loader requires an
  // explicit extension per-import even with type-stripping on, confirmed empirically — an
  // extensionless deep import throws ERR_MODULE_NOT_FOUND). The Node-side proof of the SAME
  // failover behavior runs against the real BUILT dist CLI instead (both runtimes) in
  // test/vault-leader-failover.test.ts, mirroring shutdown-boot-embed.test.ts's own pattern.
  // GH #995 fix round 2 (cross-vendor review): F1/F2/F4/F5.
  it("F2: onPromote fires on EVERY re-promotion, across TWO demote-and-reacquire cycles", {
    timeout: stallTimeout(15_000),
  }, async () => {
    // A single demote/reacquire cycle does not distinguish the fix from the bug: `splice(0)`
    // drains the callback list only on the FIRST invocation it sees, and registration here
    // happens AFTER the initial (pre-onPromote) acquisition, so that first post-registration
    // promotion fires the callbacks either way. The bug only shows on the SECOND re-promotion,
    // once `splice(0)` has already emptied the list once — this drives two full cycles so the
    // assertion can actually fail against the pre-fix code (confirmed via a source revert).
    const cacheDir = tmpDir();
    let held: Database | undefined;
    let acquireCount = 0;
    const a = track(
      await startVaultLeaderElection({
        cacheDir,
        keepaliveMs: 20,
        retryMinMs: 20,
        retryMaxMs: 30,
        onAcquire: (db) => {
          held = db;
          acquireCount += 1;
        },
      }),
    );
    expect(a.isLeader()).toBe(true);
    expect(acquireCount).toBe(1);
    let promotions = 0;
    a.onPromote(() => {
      promotions += 1;
    });
    expect(promotions).toBe(0); // never fires for the initial acquisition, per its own doc

    const waitForAcquireCount = async (n: number): Promise<void> => {
      const deadline = Date.now() + stallTimeout(8_000);
      while (acquireCount < n) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for acquireCount >= ${n}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    };

    // First demote-and-reacquire cycle. LOCK_TXN_LOSS demotes on the next keepalive tick, then
    // a's own fast retry window re-acquires it almost immediately (nothing else contends for
    // cacheDir).
    held?.exec("ROLLBACK");
    await waitForAcquireCount(2);
    expect(a.isLeader()).toBe(true);
    expect(promotions).toBe(1);

    // Second cycle — the invocation `splice(0)` used to drain the callback list on. A process
    // that promoted, demoted, and re-promoted once already previously ran THIS re-promotion with
    // an empty callback list, so `promotions` stayed at 1 forever after.
    held?.exec("ROLLBACK");
    await waitForAcquireCount(3);
    expect(a.isLeader()).toBe(true);
    expect(promotions).toBe(2);
  });

  it("F5: promote() releases and retries rather than becoming leader when the just-acquired lock file cannot be stat'd", {
    timeout: stallTimeout(10_000),
  }, async () => {
    const cacheDir = tmpDir();
    let acquisitions = 0;
    let statCalls = 0;
    let resolvePromoted!: () => void;
    const promoted = new Promise<void>((resolve) => {
      resolvePromoted = resolve;
    });
    const e = track(
      await startVaultLeaderElection({
        cacheDir,
        retryMinMs: 10,
        retryMaxMs: 15,
        onAcquire: () => {
          acquisitions += 1;
        },
        // Models an external unlink racing between this connection's BEGIN EXCLUSIVE and
        // promote()'s own stat() of the same path -- injected via statIdentity (GH #998) rather
        // than actually deleting the file this connection just opened, which Windows forbids (see
        // this file's Windows CI note above).
        statIdentity: (path) => {
          statCalls += 1;
          if (statCalls === 1) return undefined; // fail ONLY the very first stat (promote() #1)
          return statIdentity(path);
        },
      }),
    );
    // The FIRST attempt's promote() must have bailed out (release + retry) rather than claiming
    // leadership without an identity -- the election resolves as a FOLLOWER with a retry pending.
    expect(e.isLeader()).toBe(false);
    e.onPromote(() => resolvePromoted());
    await promoted;
    expect(e.isLeader()).toBe(true);
    expect(acquisitions).toBeGreaterThanOrEqual(2);
  });

  it("F5: two CONSECUTIVE identity mismatches are required before the keepalive demotes (one glitch survives)", {
    timeout: stallTimeout(10_000),
  }, async () => {
    const cacheDir = tmpDir();
    // Same injected-mismatch shape as the LOCK_FILE_REPLACEMENT case above (GH #998): the first
    // stat is promote()'s own (must see the true identity), every keepalive tick after that sees
    // a manufactured different inode forever, without ever touching the real open file.
    let statCalls = 0;
    let resolveDemoted!: () => void;
    const demoted = new Promise<void>((resolve) => {
      resolveDemoted = resolve;
    });
    const a = track(
      await startVaultLeaderElection({
        cacheDir,
        keepaliveScheduler: deterministicKeepaliveScheduler,
        // GH #1011: see waitUntilLeader's comment -- keeps `a`'s own post-demote follower retry
        // from sitting on the default 5-15s jittered window (this test never re-acquires `a`, so
        // that lingering retry would otherwise still be running, unref'd, during LATER tests).
        retryMinMs: 20,
        retryMaxMs: 40,
        statIdentity: (path) => {
          statCalls += 1;
          const real = statIdentity(path);
          if (statCalls === 1) return real;
          return real ? { dev: real.dev, ino: real.ino + 1n } : undefined;
        },
      }),
    );
    expect(a.isLeader()).toBe(true);
    a.onDemote(() => resolveDemoted());
    // Waits for the REAL demote event, driven by the DETERMINISTIC keepalive scheduler defined
    // above (CI fix round) rather than real `setTimeout` delivery. The "survives a single glitch"
    // invariant is pinned by the statCalls FLOOR below instead of a racy mid-flight isLeader()
    // check: call #1 is promote()'s own stat, call #2 is the FIRST mismatched keepalive tick
    // (streak=1, survives -- if the code demoted on a single mismatch instead of requiring two
    // consecutive ones, `demoted` would resolve with statCalls===2 and this assertion would
    // correctly fail), call #3 is the SECOND consecutive mismatch that actually demotes.
    await demoted;
    expect(a.isLeader()).toBe(false);
    expect(statCalls).toBeGreaterThanOrEqual(3);
  });

  // Windows CI: the two replacement tests above timed out at the 60s stall ceiling on windows-latest
  // because `stat().ino` is the 64-bit NTFS file ID, which routinely exceeds 2^53 -- as a double it
  // is rounded, so the tests' manufactured `ino + 1` (and a REAL replaced file's id) could compare
  // equal and the mismatch never fired. The identity must be exact (bigint), on every OS.
  it("statIdentity returns the exact bigint dev/ino, never a rounded number (file ids exceed 2^53 on Windows)", () => {
    const path = join(tmpDir(), "identity-probe");
    writeFileSync(path, "x");
    const exact = statSync(path, { bigint: true });
    const identity = statIdentity(path);
    expect(typeof identity?.ino).toBe("bigint");
    expect(typeof identity?.dev).toBe("bigint");
    expect(identity).toEqual({ dev: exact.dev, ino: exact.ino });
    expect(statIdentity(join(tmpDir(), "missing"))).toBeUndefined();
  });

  it("F4: a follower's retry classifies and logs a non-busy acquisition failure instead of silently swallowing it", async () => {
    const cacheDir = tmpDir();
    const a = track(await startVaultLeaderElection({ cacheDir }));
    expect(a.isLeader()).toBe(true);
    // The follower's OWN open() failing non-busy (SQLITE_CANTOPEN/ENOENT-shaped, not SQLITE_BUSY)
    // is injected via openLockDb (GH #998) rather than deleting the shared cacheDir -- `a`'s
    // vault-lock.db is still open inside it, and Windows forbids removing a directory that
    // contains an open file (see this file's Windows CI note above). This isolates the retry
    // loop's OWN open failure without disturbing `a`.
    let failOpen = false;
    const b = track(
      await startVaultLeaderElection({
        cacheDir,
        retryMinMs: 15,
        retryMaxMs: 25,
        openLockDb: async (dir) => {
          if (failOpen) {
            const err = new Error(
              "ENOENT: no such file or directory, open 'vault-lock.db'",
            ) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          }
          return openDatabase(join(dir, LOCK_FILE_NAME), DEFAULT_BUSY_TIMEOUT_MS);
        },
      }),
    );
    expect(b.isLeader()).toBe(false);
    // Ordinary busy contention alone (the state right now: `a` holds the lock) must never
    // populate this — it is reserved for a genuinely unexpected, non-busy failure.
    expect(b.getLastFollowerError()).toBeUndefined();
    failOpen = true;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const err = b.getLastFollowerError();
    expect(err).toBeDefined();
    expect(err?.count).toBeGreaterThanOrEqual(1);
    expect(err?.message.length).toBeGreaterThan(0);
  });

  it("F1: demote() aborts + joins the in-flight reconcile BEFORE releasing the lock — no more writes from the old leader, no overlap with the successor", {
    timeout: stallTimeout(10_000),
  }, async () => {
    const cacheDir = tmpDir();
    const writes: Array<{ owner: string; i: number }> = [];
    let activeRuns = 0;
    let maxConcurrent = 0;
    let sawAbort = false;
    const makeRaw = (owner: string) => {
      return async (signal: AbortSignal): Promise<void> => {
        activeRuns += 1;
        maxConcurrent = Math.max(maxConcurrent, activeRuns);
        try {
          for (let i = 0; i < 30; i++) {
            if (signal.aborted) {
              if (owner === "a") sawAbort = true;
              return;
            }
            writes.push({ owner, i });
            await new Promise((r) => setTimeout(r, 10));
          }
        } finally {
          activeRuns -= 1;
        }
      };
    };
    // `a` is leader with a FROZEN retry window -- isolates the invariant under test (a stops
    // writing on demote) from a's own later re-promotion, which is a separate, already-covered
    // path (F2's test above).
    let held: Database | undefined;
    const a = track(
      await startVaultLeaderElection({
        cacheDir,
        keepaliveMs: 20,
        retryMinMs: 3_600_000,
        retryMaxMs: 3_600_000,
        onAcquire: (db) => {
          held = db;
        },
      }),
    );
    expect(a.isLeader()).toBe(true);
    const aAbort = new AbortController();
    const aGated = gateReconcileByLeader(
      a,
      makeRaw("a"),
      { signal: aAbort.signal },
      {
        demoteJoinDeadlineMs: 2_000,
      },
    );
    const aRun = aGated(aAbort.signal);
    await new Promise((r) => setTimeout(r, 45)); // let a few chunks land
    expect(writes.filter((w) => w.owner === "a").length).toBeGreaterThan(0);

    // The real successor: a second election contending on the SAME cacheDir. Its retry window is
    // deliberately slower than a's keepalive-detect-then-join latency (~20ms detect + a handful of
    // ms to observe the abort and settle) so this pins the ORDERING invariant (b never promotes
    // before a's own writes have actually stopped) rather than racing it.
    const b = track(await startVaultLeaderElection({ cacheDir, retryMinMs: 150, retryMaxMs: 200 }));
    expect(b.isLeader()).toBe(false);
    const bAbort = new AbortController();
    const bGated = gateReconcileByLeader(b, makeRaw("b"), { signal: bAbort.signal });
    let resolveBPromoted!: () => void;
    const bPromoted = new Promise<void>((resolve) => {
      resolveBPromoted = resolve;
    });
    b.onPromote(() => resolveBPromoted());

    // Induce demotion of `a`: LOCK_TXN_LOSS -- demotes on the very NEXT keepalive tick (no
    // 2-consecutive-tick requirement, unlike LOCK_FILE_REPLACEMENT/F5 — see vault-lock.ts).
    held?.exec("ROLLBACK");

    await bPromoted; // b promotes once a's demote actually releases
    expect(a.isLeader()).toBe(false);
    expect(sawAbort).toBe(true); // a's reconcile observed the abort signal, not just a flag flip
    await aRun.catch(() => {});

    const aCountAtSettle = writes.filter((w) => w.owner === "a").length;
    await new Promise((r) => setTimeout(r, 80)); // let b's reconcile run for a while
    expect(writes.filter((w) => w.owner === "a").length).toBe(aCountAtSettle); // no more from a

    bAbort.abort();
    await bGated.currentRun()?.catch(() => {});
    expect(maxConcurrent).toBe(1); // a's and b's reconciles never ran at the same time
  });

  describe.skipIf(!bunAvailable)(
    "re-acquire after the holder is SIGKILLed — bun holder process",
    () => {
      it("a fresh election acquires once the holder process is killed -9", {
        timeout: stallTimeout(20_000),
      }, async () => {
        const cacheDir = tmpDir();
        const holder = spawn("bun", [HOLDER_PROBE, cacheDir], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`holder probe never reported LEADER: ${out}`)),
            stallTimeout(15_000),
          );
          holder.stdout?.on("data", (c: Buffer) => {
            out += c.toString("utf8");
            if (out.includes("LEADER")) {
              clearTimeout(timer);
              resolve();
            } else if (out.includes("FOLLOWER")) {
              clearTimeout(timer);
              reject(new Error(`holder probe unexpectedly started as FOLLOWER: ${out}`));
            }
          });
        });
        holder.kill("SIGKILL");
        await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
        const c = track(await startVaultLeaderElection({ cacheDir }));
        expect(c.isLeader()).toBe(true);
      });
    },
  );
});

// Self-review (GH #995 follow-up): a promotion-triggered reconcile runs OUTSIDE scheduler.ts's
// own per-job single-flight tracking (it dispatches this SAME wrapper directly off
// `election.onPromote`, not through the scheduler's job loop) — without a guard, a promotion
// landing while another caller of the wrapper (the boot pass, or the scheduler's own periodic
// tick) is still mid-reconcile would start a second, fully concurrent pass in one process.
describe("gateReconcileByLeader — self-review: single-flight across callers", () => {
  function fakeElection(leaderFromStart: boolean): {
    election: VaultLeaderElection;
    promote: () => void;
    demote: (reason?: string) => Promise<void>;
  } {
    let leader = leaderFromStart;
    const promoteCallbacks: Array<() => void> = [];
    const demoteCallbacks: Array<(reason: string) => Promise<void> | void> = [];
    return {
      election: {
        isLeader: () => leader,
        onPromote: (cb) => {
          promoteCallbacks.push(cb);
        },
        onDemote: (cb) => {
          demoteCallbacks.push(cb);
        },
        getLastFollowerError: () => undefined,
        close: async () => {},
      },
      promote: () => {
        leader = true;
        for (const cb of promoteCallbacks) cb();
      },
      demote: async (reason = "test demote") => {
        leader = false;
        for (const cb of demoteCallbacks) await cb(reason);
      },
    };
  }

  it("a promotion firing while another call is still in flight joins it rather than running twice", async () => {
    const { election, promote } = fakeElection(true);
    let calls = 0;
    let resolveFirst!: () => void;
    const raw = async (): Promise<void> => {
      calls += 1;
      await new Promise<void>((r) => {
        resolveFirst = r;
      });
    };
    const gated = gateReconcileByLeader(election, raw, { signal: new AbortController().signal });
    const abortSignal = new AbortController().signal;
    const firstCall = gated(abortSignal); // e.g. the boot pass
    await new Promise((resolve) => setTimeout(resolve, 10)); // let raw() start and park
    expect(calls).toBe(1);
    promote(); // fires the onPromote-triggered call while firstCall is still in flight
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1); // joined the in-flight run, did NOT start a second one
    resolveFirst();
    await firstCall;
  });

  it("a call after the in-flight run has settled starts a genuinely NEW pass", async () => {
    const { election } = fakeElection(true);
    let calls = 0;
    const raw = async (): Promise<void> => {
      calls += 1;
    };
    const gated = gateReconcileByLeader(election, raw, { signal: new AbortController().signal });
    const signal = new AbortController().signal;
    await gated(signal);
    await gated(signal);
    expect(calls).toBe(2);
  });

  // GH #995 fix round: SHUTDOWN_RECONCILE_OVERLAP — close() needs a way to JOIN a still-running
  // reconcile before releasing the leader lock (shutdown-phase.ts's joinInFlightReconcile); this
  // pins the surface it joins against.
  it("currentRun() reflects the in-flight promise while running and undefined once it settles", async () => {
    const { election } = fakeElection(true);
    let resolveRun!: () => void;
    const raw = async (): Promise<void> => {
      await new Promise<void>((r) => {
        resolveRun = r;
      });
    };
    const gated = gateReconcileByLeader(election, raw, { signal: new AbortController().signal });
    expect(gated.currentRun()).toBeUndefined();
    const call = gated(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10)); // let raw() start and park
    expect(gated.currentRun()).toBeDefined();
    resolveRun();
    await call;
    expect(gated.currentRun()).toBeUndefined();
  });
});
