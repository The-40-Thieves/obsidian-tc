// GH #1209 follow-up: ensureNotesFts used to cache `false` for the life of the connection on a
// transient SQLITE_BUSY, so one contended moment ran the whole process without full-text search,
// with no error and no health signal. A real second connection holds the write lock here (the
// provisioning DDL needs it on a cache.db that has no notes_fts yet); the assertions are on STATES
// and attempt counts, never on how long anything took.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { ensureNotesFts, upsertNoteRow } from "../src/search/fts";
import { createFtsMonitor } from "../src/search/fts-recovery";
import {
  FTS_BACKOFF_CAP_MS,
  FTS_MAX_ATTEMPTS,
  ftsBackoffMs,
  ftsRecord,
  ftsStatus,
} from "../src/search/fts-status";
import { searchTextIndexed } from "../src/search/text";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
const open: Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  delete process.env.OBSIDIAN_TC_DISABLE_FTS;
  for (const db of open.splice(0)) db.close?.();
  for (const d of dirs.splice(0)) rmTemp(d);
});

/** A provisioned cache.db with NO notes_fts yet: creating it needs the write lock. */
async function seedCache(): Promise<{ dir: string; path: string }> {
  const dir = makeTempDir("otc-fts-lock-");
  dirs.push(dir);
  const path = join(dir, "cache.db");
  const db = await openDatabase(path);
  provisionCacheDb(db);
  db.close?.();
  return { dir, path };
}

async function connect(path: string, busyMs: number): Promise<Database> {
  const db = await openDatabase(path, busyMs);
  open.push(db);
  return db;
}

/** A sibling process mid-boot: holds SQLite's single write lock until `release()`. */
async function holdWriteLock(path: string): Promise<{ release: () => void }> {
  const holder = await connect(path, 1000);
  holder.exec("BEGIN IMMEDIATE");
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      holder.exec("ROLLBACK");
    },
  };
}

const rec = (p: string) => ({
  path: p,
  title: p,
  tagsJson: "[]",
  frontmatterJson: "{}",
  contentHash: "hash-1",
  mtime: 1,
  size: 1,
  ftsContent: `body text of ${p}`,
  fenceGeneration: 0,
  fenceCheckRequired: false,
});

describe("ensureNotesFts under a real write lock", () => {
  it("reports recovering (with the lock error), not a silent false", async () => {
    const { path } = await seedCache();
    const lock = await holdWriteLock(path);
    try {
      const db = await connect(path, 50);
      expect(ensureNotesFts(db)).toBe(false);
      const status = ftsStatus(db);
      expect(status).toMatchObject({
        state: "recovering",
        reason: "lock_contention",
        attempts: 1,
        max_attempts: FTS_MAX_ATTEMPTS,
      });
      if (status.state === "recovering") expect(status.last_error).toMatch(/locked/i);
      // The old code wrote a memoized `false` here; the record must stay open to a retry.
      expect(ftsRecord(db)?.kind).toBe("transient");
    } finally {
      lock.release();
    }
  });

  it("is not memoized: once the lock is released the next attempt provisions FTS", async () => {
    const { path } = await seedCache();
    const lock = await holdWriteLock(path);
    const db = await connect(path, 50);
    expect(ensureNotesFts(db, { now: () => 0 })).toBe(false);
    lock.release();
    // Inside the backoff window the call is a no-op (asserted separately); `force` is the monitor's way in.
    expect(ensureNotesFts(db, { now: () => 0, force: true })).toBe(true);
    expect(ftsStatus(db)).toEqual({ state: "available" });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'notes_fts'").get(),
    ).toBeDefined();
  });

  it("does not touch the database inside the backoff window (no retry storm from write paths)", async () => {
    const { path } = await seedCache();
    const lock = await holdWriteLock(path);
    const db = await connect(path, 50);
    expect(ensureNotesFts(db, { now: () => 0 })).toBe(false);
    lock.release(); // a real attempt would now succeed, so a false below proves none was made
    expect(ensureNotesFts(db, { now: () => ftsBackoffMs(1) - 1 })).toBe(false);
    expect(ftsStatus(db)).toMatchObject({ state: "recovering", attempts: 1 });
    // Past the window the same call retries and succeeds.
    expect(ensureNotesFts(db, { now: () => ftsBackoffMs(1) })).toBe(true);
  });

  it("backs off exponentially to a cap, and spent retries read unavailable(lock_contention), still not memoized", async () => {
    const { path } = await seedCache();
    const lock = await holdWriteLock(path);
    const db = await connect(path, 20);
    const delays = Array.from({ length: FTS_MAX_ATTEMPTS + 3 }, (_, i) => ftsBackoffMs(i + 1));
    expect(delays[0]).toBeLessThan(delays[1] ?? 0);
    expect(Math.max(...delays)).toBe(FTS_BACKOFF_CAP_MS);
    for (let i = 0; i < FTS_MAX_ATTEMPTS; i++) ensureNotesFts(db, { now: () => 0, force: true });
    expect(ftsStatus(db)).toMatchObject({
      state: "unavailable",
      reason: "lock_contention",
      attempts: FTS_MAX_ATTEMPTS,
    });
    lock.release();
    expect(ensureNotesFts(db, { now: () => 0, force: true })).toBe(true);
    expect(ftsStatus(db)).toEqual({ state: "available" });
  });
});

describe("a non-transient failure stays distinct and loud", () => {
  it("memoizes provision_failed with the real error, never reported as a lock", async () => {
    const { path } = await seedCache();
    const real = await connect(path, 50);
    let execs = 0;
    const broken: Database = {
      exec(sql: string) {
        execs++;
        if (/CREATE VIRTUAL TABLE/.test(sql)) throw new Error("no such module: fts5");
        real.exec(sql);
      },
      prepare: (sql: string) => real.prepare(sql),
    };
    expect(ensureNotesFts(broken)).toBe(false);
    expect(ftsStatus(broken)).toEqual({
      state: "unavailable",
      reason: "provision_failed",
      last_error: "no such module: fts5",
    });
    const before = execs;
    expect(ensureNotesFts(broken, { force: true })).toBe(false);
    expect(execs).toBe(before); // memoized: a real fault is not retried like a lock
  });

  it("OBSIDIAN_TC_DISABLE_FTS is a deliberate, distinct unavailable(disabled)", async () => {
    const { path } = await seedCache();
    const db = await connect(path, 50);
    process.env.OBSIDIAN_TC_DISABLE_FTS = "1";
    expect(ensureNotesFts(db)).toBe(false);
    expect(ftsStatus(db)).toEqual({ state: "unavailable", reason: "disabled" });
  });
});

describe("FTS monitor: background recovery with no restart", () => {
  it("retries on its backoff, flips to available when the lock clears, reconciles once, and searches use FTS", async () => {
    const { dir, path } = await seedCache();
    const lock = await holdWriteLock(path);
    const db = await connect(path, 20);
    vi.useFakeTimers();
    const logs: string[] = [];
    const onRecovered = vi.fn();

    expect(ensureNotesFts(db)).toBe(false); // the boot probe, under the lock
    const monitor = createFtsMonitor(db, { log: (m) => logs.push(m) });
    const idx = monitor.metadataIndex(() => true);
    expect(monitor.status().state).toBe("recovering");
    expect(idx.hasFts).toBe(false);
    expect(logs.join("\n")).toMatch(/notes_fts unavailable .*retrying in the background/);

    monitor.schedule({ initialized: Promise.resolve(), onRecovered });
    await vi.advanceTimersByTimeAsync(ftsBackoffMs(1) + 1);
    expect(ftsStatus(db)).toMatchObject({ state: "recovering", attempts: 2 }); // retried, still locked
    expect(onRecovered).not.toHaveBeenCalled();

    lock.release();
    await vi.advanceTimersByTimeAsync(FTS_BACKOFF_CAP_MS * 2);
    expect(monitor.status()).toEqual({ state: "available" });
    expect(idx.hasFts).toBe(true); // the SAME object the search tools hold sees the recovery
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toMatch(/notes_fts recovered/);

    // Search uses it: an FTS write and an indexed lookup on the recovered connection.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "a.md"), "body text of a.md\n");
    upsertNoteRow(db, "main", rec("a.md"), idx.hasFts, 1);
    const hits = searchTextIndexed(db, "main", dir, { query: "text of a", limit: 100 });
    expect(hits?.map((h) => h.path)).toEqual(["a.md"]);

    // Nothing keeps retrying once recovered.
    const before = ftsRecord(db);
    await vi.advanceTimersByTimeAsync(FTS_BACKOFF_CAP_MS * 20);
    expect(ftsRecord(db)).toBe(before);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    monitor.cancel();
  });

  it("is bounded: a lock that never clears costs at most FTS_MAX_ATTEMPTS attempts, then stops and says so", async () => {
    const { path } = await seedCache();
    const lock = await holdWriteLock(path);
    const db = await connect(path, 20);
    vi.useFakeTimers();
    const logs: string[] = [];
    expect(ensureNotesFts(db)).toBe(false);
    const monitor = createFtsMonitor(db, { log: (m) => logs.push(m) });
    monitor.schedule({ initialized: Promise.resolve() });

    await vi.advanceTimersByTimeAsync(FTS_BACKOFF_CAP_MS * (FTS_MAX_ATTEMPTS + 2));
    expect(ftsStatus(db)).toMatchObject({
      state: "unavailable",
      reason: "lock_contention",
      attempts: FTS_MAX_ATTEMPTS,
    });
    expect(logs.filter((m) => /still locked after/.test(m))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(FTS_BACKOFF_CAP_MS * 50);
    expect(ftsStatus(db)).toMatchObject({ attempts: FTS_MAX_ATTEMPTS }); // no storm after the budget
    expect(vi.getTimerCount()).toBe(0);
    monitor.cancel();
    lock.release();
  });

  it("cancel() before the handshake means no retry is ever armed", async () => {
    const { path } = await seedCache();
    const lock = await holdWriteLock(path);
    const db = await connect(path, 20);
    vi.useFakeTimers();
    expect(ensureNotesFts(db)).toBe(false);
    const monitor = createFtsMonitor(db, { log: () => {} });
    monitor.schedule({ initialized: new Promise<void>(() => {}), maxWaitMs: 60_000 });
    monitor.cancel();
    await vi.advanceTimersByTimeAsync(FTS_BACKOFF_CAP_MS * 20);
    expect(ftsStatus(db)).toMatchObject({ state: "recovering", attempts: 1 });
    lock.release();
  });

  it("a failure that is not a lock is logged loudly when the monitor starts", async () => {
    const { path } = await seedCache();
    const real = await connect(path, 50);
    const broken: Database = {
      exec(sql: string) {
        if (/CREATE VIRTUAL TABLE/.test(sql)) throw new Error("no such module: fts5");
        real.exec(sql);
      },
      prepare: (sql: string) => real.prepare(sql),
    };
    ensureNotesFts(broken);
    const logs: string[] = [];
    const monitor = createFtsMonitor(broken, { log: (m) => logs.push(m) });
    expect(logs).toEqual([
      "obsidian-tc: notes_fts failed (provision_failed: no such module: fts5)",
    ]);
    expect(monitor.status()).toMatchObject({ state: "unavailable", reason: "provision_failed" });
    monitor.cancel();
  });
});

describe("ensureChunkFts shares the class (it feeds the hybrid lexical stream)", () => {
  it("does not memoize false on a lock: it provisions once the lock is gone", async () => {
    const { path } = await seedCache();
    const lock = await holdWriteLock(path);
    const db = await connect(path, 50);
    expect(ensureChunkFts(db, { now: () => 0 })).toBe(false);
    lock.release();
    expect(ensureChunkFts(db, { now: () => 0 })).toBe(false); // inside the backoff window: untouched
    expect(ensureChunkFts(db, { now: () => ftsBackoffMs(1) })).toBe(true);
  });
});
