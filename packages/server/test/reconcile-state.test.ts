// The leader's reconcile outcome, persisted to cache.db so a follower process can report it
// (GH #995: only the leader runs reconciles, so a follower's in-memory indexHealth stays pending).
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import {
  persistNotesReady,
  persistReconcileState,
  persistRunOutcome,
  readPersistedReconcileState,
} from "../src/runtime/reconcile-state";
import { bumpLeaderEpoch, readLeaderEpoch } from "../src/search/indexing/leader-epoch";
import { openMemoryDb } from "./helpers";

/** A file-backed connection: the lock test needs two on one cache.db. Loaded through createRequire
 *  like helpers.ts, so Vite never resolves the node:sqlite builtin statically. */
function openFileDb(path: string): any {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  return new DatabaseSync(path);
}

describe("reconcile_state (leader-persisted reconcile outcome)", () => {
  it("reads as undefined, without throwing, before the migration has created the table", () => {
    // Defensive: no migration has run on this cache.db, so the table does not exist.
    const db = openMemoryDb();
    expect(readPersistedReconcileState(db)).toBeUndefined();
  });

  it("reads as undefined on a provisioned cache.db no leader has written to yet", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    expect(readPersistedReconcileState(db)).toBeUndefined();
  });

  it("round-trips the outcome, its errors and notes_ready", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    persistReconcileState(
      db,
      { reconcile: "degraded", reconcileAt: 42, reconcileErrors: [{ vault: "v1", error: "boom" }] },
      true,
      readLeaderEpoch(db),
    );
    expect(readPersistedReconcileState(db)).toEqual({
      reconcile: "degraded",
      reconcileAt: 42,
      reconcileErrors: [{ vault: "v1", error: "boom" }],
      notesReady: true,
    });
  });

  it("overwrites the single row on each completed pass (degraded -> ok)", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    persistReconcileState(
      db,
      { reconcile: "degraded", reconcileAt: 1, reconcileErrors: [{ vault: "v1", error: "x" }] },
      true,
      0,
    );
    persistReconcileState(db, { reconcile: "ok", reconcileAt: 2, reconcileErrors: [] }, true, 0);
    expect(readPersistedReconcileState(db)).toEqual({
      reconcile: "ok",
      reconcileAt: 2,
      reconcileErrors: [],
      notesReady: true,
    });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM reconcile_state").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("never clears notes_ready once a pass has set it", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    persistReconcileState(db, { reconcile: "ok", reconcileAt: 1, reconcileErrors: [] }, true, 0);
    persistReconcileState(db, { reconcile: "ok", reconcileAt: 2, reconcileErrors: [] }, false, 0);
    expect(readPersistedReconcileState(db)?.notesReady).toBe(true);
  });

  it("persistNotesReady sets notes_ready without touching the reconcile outcome", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    persistReconcileState(db, { reconcile: "ok", reconcileAt: 7, reconcileErrors: [] }, false, 0);
    persistNotesReady(db, 0);
    expect(readPersistedReconcileState(db)).toEqual({
      reconcile: "ok",
      reconcileAt: 7,
      reconcileErrors: [],
      notesReady: true,
    });
  });

  it("persistNotesReady on a cache.db with no row records notes_ready as pending", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    persistNotesReady(db, 0);
    expect(readPersistedReconcileState(db)).toEqual({
      reconcile: "pending",
      reconcileAt: null,
      reconcileErrors: [],
      notesReady: true,
    });
  });

  it("a write that hits a locked cache.db is swallowed, never thrown (GH #995 review)", async () => {
    // A concurrent writer (obsidian-tc compact, a large follower index flush) holds the write lock
    // past busy_timeout. The reconcile runner and the notes pass must survive it: a throw here
    // rejects the whole runner, or cuts a vault's pass short.
    const dir = mkdtempSync(join(tmpdir(), "reconcile-state-"));
    const leader = openFileDb(join(dir, "cache.db"));
    const other = openFileDb(join(dir, "cache.db"));
    try {
      provisionCacheDb(leader);
      leader.exec("PRAGMA busy_timeout = 50");
      other.exec("BEGIN IMMEDIATE");
      expect(() =>
        persistReconcileState(
          leader,
          { reconcile: "ok", reconcileAt: 1, reconcileErrors: [] },
          true,
          0,
        ),
      ).not.toThrow();
      expect(() => persistNotesReady(leader, 0)).not.toThrow();
      other.exec("ROLLBACK");
    } finally {
      other.close();
      leader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads as pending once a successor has promoted (the row's epoch is superseded)", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    persistReconcileState(db, { reconcile: "ok", reconcileAt: 1, reconcileErrors: [] }, true, 0);
    bumpLeaderEpoch(db, 2);
    expect(readPersistedReconcileState(db)).toBeUndefined();
  });

  it("copies only { vault, error } from each persisted error and drops malformed entries", () => {
    // A newer leader may write extra keys; the client-side ajv check rejects any extra key.
    const db = openMemoryDb();
    provisionCacheDb(db);
    db.prepare(
      "INSERT INTO reconcile_state (id, state, reconcile_at, reconcile_errors, notes_ready) VALUES (1, 'degraded', 5, ?, 1)",
    ).run(
      JSON.stringify([
        { vault: "v1", error: "boom", kind: "embed" },
        { vault: 3, error: "not a string vault" },
      ]),
    );
    expect(readPersistedReconcileState(db)?.reconcileErrors).toEqual([
      { vault: "v1", error: "boom" },
    ]);
  });

  it("reads as pending, not a throw, when the errors column is not a JSON array", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const insert = db.prepare(
      "INSERT INTO reconcile_state (id, state, reconcile_at, reconcile_errors, notes_ready) VALUES (1, 'ok', 5, ?, 0)",
    );
    insert.run("{not json");
    expect(readPersistedReconcileState(db)).toBeUndefined();
    db.exec("DELETE FROM reconcile_state");
    insert.run('{"vault":"v1"}');
    expect(readPersistedReconcileState(db)).toBeUndefined();
  });

  it("reads as pending when the state is outside the known set", () => {
    // The CHECK constraint stops this on today's table; a table without it is what a future or
    // mixed-version writer could leave behind.
    const db = openMemoryDb();
    provisionCacheDb(db);
    db.exec("DROP TABLE reconcile_state");
    db.exec(
      "CREATE TABLE reconcile_state (id INTEGER PRIMARY KEY, state TEXT, reconcile_at INTEGER, " +
        "reconcile_errors TEXT, notes_ready INTEGER, epoch INTEGER NOT NULL DEFAULT 0)",
    );
    db.prepare(
      "INSERT INTO reconcile_state (id, state, reconcile_at, reconcile_errors, notes_ready, epoch) VALUES (1, 'stale-future', 5, '[]', 1, 0)",
    ).run();
    expect(readPersistedReconcileState(db)).toBeUndefined();
  });

  it("persistNotesReady stamps the current leader epoch: a bumped-epoch notes pass reads notes_ready true", () => {
    // wireLeaderEpoch bumps index_leader_epoch on every leader start or promotion, so a leader's
    // epoch is 1 or more. A notes write stamped with the column default 0 reads as superseded.
    const db = openMemoryDb();
    provisionCacheDb(db);
    bumpLeaderEpoch(db, 1);
    persistNotesReady(db, readLeaderEpoch(db));
    expect(readPersistedReconcileState(db)).toEqual({
      reconcile: "pending",
      reconcileAt: null,
      reconcileErrors: [],
      notesReady: true,
    });
  });

  it("persistNotesReady under a newer epoch resets the predecessor's outcome to pending", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    bumpLeaderEpoch(db, 1);
    persistReconcileState(
      db,
      { reconcile: "degraded", reconcileAt: 9, reconcileErrors: [{ vault: "v1", error: "x" }] },
      true,
      readLeaderEpoch(db),
    );
    bumpLeaderEpoch(db, 2);
    persistNotesReady(db, readLeaderEpoch(db));
    expect(readPersistedReconcileState(db)).toEqual({
      reconcile: "pending",
      reconcileAt: null,
      reconcileErrors: [],
      notesReady: true,
    });
  });

  it("a notes pass from a superseded epoch is not persisted", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    bumpLeaderEpoch(db, 1);
    const captured = readLeaderEpoch(db);
    bumpLeaderEpoch(db, 2);
    persistNotesReady(db, captured);
    expect(readPersistedReconcileState(db)).toBeUndefined();
  });

  it("a failing leader-epoch read is swallowed, never thrown, on the run-outcome and notes paths", () => {
    // The stale check reads index_leader_epoch. Renaming its column makes that read throw, the
    // same way a "database is locked" read would. Both entry points must resolve.
    const db = openMemoryDb();
    provisionCacheDb(db);
    db.exec("ALTER TABLE index_leader_epoch RENAME COLUMN epoch TO epoch_renamed");
    const run = { signal: new AbortController().signal, epoch: 0 };
    expect(() =>
      persistRunOutcome(db, { reconcile: "ok", reconcileAt: 1, reconcileErrors: [] }, true, run),
    ).not.toThrow();
    expect(() => persistNotesReady(db, 0)).not.toThrow();
  });

  it("a pass at a newer epoch does not carry notes_ready from the older epoch", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    bumpLeaderEpoch(db, 1);
    persistReconcileState(db, { reconcile: "ok", reconcileAt: 1, reconcileErrors: [] }, true, 1);
    bumpLeaderEpoch(db, 2);
    persistReconcileState(db, { reconcile: "ok", reconcileAt: 2, reconcileErrors: [] }, false, 2);
    expect(readPersistedReconcileState(db)?.notesReady).toBe(false);
  });

  it("reads as pending, not a throw, when the row cannot be read (renamed epoch column)", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    persistReconcileState(db, { reconcile: "ok", reconcileAt: 1, reconcileErrors: [] }, true, 0);
    db.exec("ALTER TABLE reconcile_state RENAME COLUMN epoch TO epoch_renamed");
    expect(() => readPersistedReconcileState(db)).not.toThrow();
    expect(readPersistedReconcileState(db)).toBeUndefined();
  });
});
