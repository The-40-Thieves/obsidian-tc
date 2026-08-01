// THE-585 (#5): the SQL lock-wait seam. These tests contend two REAL connections against one
// database file rather than stubbing a clock — the whole value of the metric is that it reflects
// SQLite's actual locking behavior, and a mocked timer would happily pass while measuring nothing
// (the failure mode that made boot.tools_list_ms read 0.3 ms for a 59.6 ms path).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { busyReason, inWriteTransaction, type WriteTxnLabel } from "../src/db/txn";
import type { Database } from "../src/db/types";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { makeM2Vault } from "./m2-helpers";
import { rmTemp } from "./tmp";

const dirs: string[] = [];
const conns: Database[] = [];
afterEach(() => {
  for (const c of conns.splice(0)) c.close?.();
  for (const d of dirs.splice(0)) rmTemp(d);
});

/** Two independent connections to one file, as a reindex and a live tool call would be. */
async function contendingPair(busyTimeoutMs: number): Promise<[Database, Database]> {
  const dir = mkdtempSync(join(tmpdir(), "lockwait-"));
  dirs.push(dir);
  const path = join(dir, "cache.db");
  const a = await openNodeSqlite(path);
  const b = await openNodeSqlite(path);
  conns.push(a, b);
  for (const db of [a, b]) db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  a.exec("CREATE TABLE t(v TEXT)");
  a.exec("INSERT INTO t(v) VALUES ('seed')");
  return [a, b];
}

interface Recorded {
  waits: Array<{ label: WriteTxnLabel; seconds: number }>;
  busy: Array<{ label: WriteTxnLabel; reason: string }>;
}
function recorder(): { hooks: Parameters<typeof inWriteTransaction>[3]; rec: Recorded } {
  const rec: Recorded = { waits: [], busy: [] };
  return {
    rec,
    hooks: {
      onLockWait: (label, seconds) => rec.waits.push({ label, seconds }),
      onBusy: (label, reason) => rec.busy.push({ label, reason }),
    },
  };
}

describe("THE-585 #5 — inWriteTransaction measures the write-lock wait", () => {
  it("observes a near-zero wait when nothing is contending (the histogram's denominator)", async () => {
    const [a] = await contendingPair(5000);
    const { hooks, rec } = recorder();
    const out = inWriteTransaction(
      a,
      "index_batch",
      () => {
        a.exec("INSERT INTO t(v) VALUES ('uncontended')");
        return "committed";
      },
      hooks,
    );
    expect(out).toBe("committed");
    // Every acquisition is observed, not only the slow ones: without the fast samples there is no
    // denominator and "5% of index writes waited >100ms" cannot be computed at all.
    expect(rec.waits).toHaveLength(1);
    expect(rec.waits[0]?.label).toBe("index_batch");
    expect(rec.waits[0]?.seconds).toBeLessThan(0.1);
    expect(rec.busy).toEqual([]);
    expect((a.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(2);
  });

  // The load-bearing test. If BEGIN IMMEDIATE were swapped back to a deferred BEGIN, this is the
  // assertion that fails: the wait would move to the first INSERT and be recorded as ~0.
  it("observes a REAL multi-hundred-ms wait while another connection holds the write lock", async () => {
    const TIMEOUT_MS = 400;
    const [a, b] = await contendingPair(TIMEOUT_MS);
    b.exec("BEGIN IMMEDIATE"); // b now owns the write lock and will not release it
    b.exec("INSERT INTO t(v) VALUES ('holder')");

    const { hooks, rec } = recorder();
    expect(() =>
      inWriteTransaction(a, "job_claim", () => a.exec("INSERT INTO t(v) VALUES ('waiter')"), hooks),
    ).toThrow();

    expect(rec.waits).toHaveLength(1);
    // It genuinely blocked for the configured busy_timeout rather than failing fast. The floor is
    // deliberately well under TIMEOUT_MS (SQLite's busy handler is not a precise sleep), but far
    // above anything a no-op could produce.
    expect(rec.waits[0]?.seconds).toBeGreaterThan((TIMEOUT_MS * 0.5) / 1000);
    expect(rec.waits[0]?.label).toBe("job_claim");
    // A failed acquisition is a busy event too — and it is counted at the FULL wait, which is the
    // single most important sample in the histogram.
    expect(rec.busy).toEqual([{ label: "job_claim", reason: "busy" }]);
    b.exec("ROLLBACK");
  });

  it("rolls back and propagates a body error without swallowing it", async () => {
    const [a] = await contendingPair(5000);
    const { hooks, rec } = recorder();
    const boom = new Error("body failed");
    expect(() =>
      inWriteTransaction(
        a,
        "index_note",
        () => {
          a.exec("INSERT INTO t(v) VALUES ('doomed')");
          throw boom;
        },
        hooks,
      ),
    ).toThrow(boom);
    expect((a.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(1);
    // A non-busy failure must not be miscounted as contention.
    expect(rec.busy).toEqual([]);
    expect(rec.waits).toHaveLength(1);
  });

  it("never lets a throwing metrics sink break a transaction that would have committed", async () => {
    const [a] = await contendingPair(5000);
    const out = inWriteTransaction(
      a,
      "index_generation",
      () => {
        a.exec("INSERT INTO t(v) VALUES ('ok')");
        return 42;
      },
      {
        onLockWait: () => {
          throw new Error("metrics sink is down");
        },
        onBusy: () => {
          throw new Error("metrics sink is down");
        },
      },
    );
    expect(out).toBe(42);
    expect((a.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(2);
  });
});

describe("THE-585 #5 — the deferred-upgrade failure inWriteTransaction removes", () => {
  // Documents WHY the write paths moved off `BEGIN`. A deferred transaction that reads and then
  // writes can fail in a way busy_timeout is powerless against; BEGIN IMMEDIATE cannot reach that
  // state, because it never holds a read snapshot it has to upgrade.
  it("a deferred BEGIN read-then-write fails INSTANTLY with SQLITE_BUSY_SNAPSHOT", async () => {
    const TIMEOUT_MS = 3000;
    const [a, b] = await contendingPair(TIMEOUT_MS);

    a.exec("BEGIN"); // deferred: takes no lock, only a read snapshot once we read
    a.prepare("SELECT count(*) FROM t").get();

    b.exec("BEGIN IMMEDIATE"); // another writer commits in the meantime, releasing the lock after
    b.exec("INSERT INTO t(v) VALUES ('other')");
    b.exec("COMMIT");

    const started = performance.now();
    let caught: unknown;
    try {
      a.exec("INSERT INTO t(v) VALUES ('upgrade')");
    } catch (e) {
      caught = e;
    }
    const elapsedMs = performance.now() - started;

    expect(caught).toBeDefined();
    expect(busyReason(caught)).toBe("snapshot");
    // Nothing holds the lock, yet it failed anyway — and it did NOT wait out busy_timeout, which is
    // what makes this class of failure unrescuable by configuration.
    expect(elapsedMs).toBeLessThan(TIMEOUT_MS / 10);
    a.exec("ROLLBACK");
  });

  it("the same read-then-write sequence commits under inWriteTransaction", async () => {
    const [a, b] = await contendingPair(3000);
    b.exec("INSERT INTO t(v) VALUES ('other')"); // committed before a starts, autocommit

    const out = inWriteTransaction(a, "index_deindex", () => {
      const before = a.prepare("SELECT count(*) AS n FROM t").get() as { n: number };
      a.exec("INSERT INTO t(v) VALUES ('upgrade')"); // read THEN write — the shape that failed above
      return before.n;
    });
    expect(out).toBe(2);
    expect((a.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(3);
  });
});

describe("THE-585 #5 — indexVault actually emits samples through the seam", () => {
  // A metric that is registered but never fired reads as a healthy zero forever. Codex's review of
  // this change found exactly that: deindexNote had been given a `sql` parameter, but indexVault's
  // stale-path sweep called it without one, so every reconcile deletion was invisible. Assert the
  // LABELS observed end-to-end, not merely that the plumbing typechecks.
  it("reports a lock-wait sample for every write transaction an index pass opens", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta" } });
    const seen: WriteTxnLabel[] = [];
    const sql = { onLockWait: (label: WriteTxnLabel) => seen.push(label) };
    const args = {
      db: v.db,
      provider: v.provider,
      representation: buildRepresentationManifest(v.provider, {}),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      sql,
    };
    await indexVault(args);
    // The chunk batch, the notes flush, and THE-496's generation bump — the same three transactions
    // test/indexer.test.ts pins as the P2 batching invariant.
    expect(new Set(seen)).toEqual(
      new Set<WriteTxnLabel>(["index_batch", "index_notes_flush", "index_generation"]),
    );

    // Now delete a note on disk and reconcile: the stale-path sweep must report too.
    seen.length = 0;
    rmSync(join(v.root, "b.md"));
    await indexVault(args);
    expect(seen).toContain("index_deindex");
  });
});

describe("THE-585 #5 — busyReason classifies every adapter's error shape", () => {
  // Each shape below was read off a live error from that adapter, not from its documentation.
  // `message` is byte-identical ("database is locked") on all three, so it cannot discriminate;
  // node:sqlite carries no distinguishing `code`, and better-sqlite3 carries no numeric code.
  const cases: Array<[string, Record<string, unknown>, "busy" | "snapshot" | null]> = [
    ["bun:sqlite busy", { code: "SQLITE_BUSY", errno: 5, message: "database is locked" }, "busy"],
    [
      "bun:sqlite snapshot",
      { code: "SQLITE_BUSY_SNAPSHOT", errno: 517, message: "database is locked" },
      "snapshot",
    ],
    ["better-sqlite3 busy", { code: "SQLITE_BUSY", message: "database is locked" }, "busy"],
    [
      "better-sqlite3 snapshot",
      { code: "SQLITE_BUSY_SNAPSHOT", message: "database is locked" },
      "snapshot",
    ],
    [
      "node:sqlite busy",
      { code: "ERR_SQLITE_ERROR", errcode: 5, message: "database is locked" },
      "busy",
    ],
    [
      "node:sqlite snapshot",
      { code: "ERR_SQLITE_ERROR", errcode: 517, message: "database is locked" },
      "snapshot",
    ],
    // Extended busy codes keep SQLITE_BUSY in the low byte, so the numeric test masks.
    ["SQLITE_BUSY_RECOVERY (261)", { code: "ERR_SQLITE_ERROR", errcode: 261 }, "busy"],
    ["SQLITE_BUSY_TIMEOUT (773)", { code: "ERR_SQLITE_ERROR", errcode: 773 }, "busy"],
    // Not busy: must not be counted as contention.
    ["constraint violation", { code: "SQLITE_CONSTRAINT", errcode: 19 }, null],
    ["SQLITE_LOCKED is a different code", { code: "SQLITE_LOCKED", errcode: 6 }, null],
    ["plain Error", { message: "database is locked" }, null],
  ];
  for (const [name, shape, expected] of cases) {
    it(`classifies ${name} as ${expected ?? "not busy"}`, () => {
      expect(busyReason(Object.assign(new Error(String(shape.message ?? "x")), shape))).toBe(
        expected,
      );
    });
  }

  it("does not throw on non-object inputs", () => {
    for (const v of [null, undefined, "database is locked", 5, 517]) {
      expect(busyReason(v)).toBeNull();
    }
  });
});
