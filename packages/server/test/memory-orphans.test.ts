// Orphan sweep for memory_entities / memory_relations / memory_observation_intervals.
//
// The point of these tests is the NEGATIVE space: memory rows are user data with no other copy
// (an entity created with materialize:false lives only in SQLite), so every case below that must
// SURVIVE is as load-bearing as the ones that must go. `freshDb()` turns `foreign_keys` OFF (the
// adapter's default is ON), which is what lets a test seed a dangling row directly — the same state
// a connection that never set the pragma produces in the wild.
import { describe, expect, it, vi } from "vitest";
import { registerMemoryOrphanSweep, sweepMemoryOrphans } from "../src/db/memory-orphans";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { Scheduler } from "../src/scheduler/scheduler";
import { openMemoryDb } from "./helpers";

const DAY = 86_400_000;
const NOW = 10_000_000_000_000;
const OLD = NOW - 400 * DAY;
const RECENT = NOW - 1 * DAY;

function freshDb(foreignKeys = false): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  return db;
}

interface EntitySeed {
  id: string;
  vault?: string;
  status?: "active" | "retired";
  observations?: string;
  updatedAt?: number;
  vaultPath?: string | null;
}

function entity(db: Database, e: EntitySeed): void {
  db.prepare(
    `INSERT INTO memory_entities
       (id, vault_id, entity_type, name, observations, materialize, vault_path, created_at, updated_at, status)
     VALUES (?, ?, 'thing', ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.vault ?? "main",
    e.id,
    e.observations ?? "",
    e.vaultPath ?? null,
    e.updatedAt ?? OLD,
    e.updatedAt ?? OLD,
    e.status ?? "active",
  );
}

function relation(db: Database, source: string, target: string, type = "rel"): void {
  db.prepare(
    "INSERT INTO memory_relations (source_id, target_id, relation_type, created_at) VALUES (?, ?, ?, ?)",
  ).run(source, target, type, OLD);
}

function interval(db: Database, entityId: string): void {
  db.prepare(
    `INSERT INTO memory_observation_intervals (entity_id, obs_hash, key, valid_from, valid_to, superseded_by, created_at)
     VALUES (?, 'h', NULL, ?, NULL, NULL, ?)`,
  ).run(entityId, OLD, OLD);
}

const ids = (db: Database, table: string, col: string): string[] =>
  (db.prepare(`SELECT ${col} AS v FROM ${table} ORDER BY ${col}`).all() as { v: string }[]).map(
    (r) => r.v,
  );
const entityIds = (db: Database) => ids(db, "memory_entities", "id");
const relationRows = (db: Database) =>
  (
    db
      .prepare("SELECT source_id AS s, target_id AS t FROM memory_relations ORDER BY 1, 2")
      .all() as {
      s: string;
      t: string;
    }[]
  ).map((r) => `${r.s}>${r.t}`);
const intervalOwners = (db: Database) => ids(db, "memory_observation_intervals", "entity_id");

const BASE = { now: NOW, batchSize: 100 };

describe("sweepMemoryOrphans — default class: dangling children", () => {
  it("removes relations whose source or target entity row is gone, and only those", () => {
    const db = freshDb();
    entity(db, { id: "a" });
    entity(db, { id: "b" });
    relation(db, "a", "b"); // live -> live: must stay
    relation(db, "a", "ghost1"); // dangling target
    relation(db, "ghost2", "b"); // dangling source
    relation(db, "ghost3", "ghost4"); // both ends gone

    const counts = sweepMemoryOrphans(db, BASE);

    expect(counts.dangling_relations).toBe(3);
    expect(relationRows(db)).toEqual(["a>b"]);
    expect(entityIds(db)).toEqual(["a", "b"]);
  });

  it("removes interval rows whose entity is gone (delete_entity leaves them to the FK cascade)", () => {
    const db = freshDb();
    entity(db, { id: "a", observations: "fact" });
    interval(db, "a");
    interval(db, "ghost");
    interval(db, "ghost");

    const counts = sweepMemoryOrphans(db, BASE);

    expect(counts.dangling_intervals).toBe(2);
    expect(intervalOwners(db)).toEqual(["a"]);
  });

  it("never deletes an entity: standalone entities with or without observations, retired or old, all survive", () => {
    const db = freshDb();
    entity(db, { id: "solo-with-obs", observations: "a fact\nanother fact" });
    entity(db, { id: "solo-blank", observations: "" });
    entity(db, { id: "solo-retired-blank", status: "retired", observations: "" });
    entity(db, { id: "other-vault", vault: "not-registered-anywhere" });
    interval(db, "solo-with-obs");

    const counts = sweepMemoryOrphans(db, BASE);

    expect(entityIds(db)).toEqual([
      "other-vault",
      "solo-blank",
      "solo-retired-blank",
      "solo-with-obs",
    ]);
    expect(intervalOwners(db)).toEqual(["solo-with-obs"]);
    expect(counts).toMatchObject({
      dangling_relations: 0,
      dangling_intervals: 0,
      retired_entities: 0,
      removed_vault_entities: 0,
    });
  });

  it("is a no-op that reports zeros when the memory tables do not exist", () => {
    const db = openMemoryDb();
    expect(sweepMemoryOrphans(db, BASE)).toMatchObject({
      dangling_relations: 0,
      dangling_intervals: 0,
      retired_entities: 0,
      removed_vault_entities: 0,
      batches: 0,
    });
  });
});

describe("sweepMemoryOrphans — opt-in class: retired entities with nothing left in them", () => {
  function seedRetired(db: Database): void {
    entity(db, { id: "r-gone", status: "retired", observations: "" }); // the only candidate
    entity(db, { id: "r-ws", status: "retired", observations: " \t\n" }); // whitespace-only == blank
    entity(db, { id: "r-obs", status: "retired", observations: "still a fact" });
    entity(db, { id: "r-recent", status: "retired", updatedAt: RECENT });
    entity(db, { id: "r-related", status: "retired" });
    entity(db, { id: "r-interval", status: "retired" });
    entity(db, { id: "r-note", status: "retired", vaultPath: "memory/r-note.md" });
    entity(db, { id: "active-blank", status: "active" });
    entity(db, { id: "peer" });
    relation(db, "r-related", "peer");
    interval(db, "r-interval");
  }

  it("does nothing unless retiredRetentionDays is set", () => {
    const db = freshDb();
    seedRetired(db);
    const before = entityIds(db);
    const counts = sweepMemoryOrphans(db, BASE);
    expect(counts.retired_entities).toBe(0);
    expect(entityIds(db)).toEqual(before);
  });

  it("deletes only retired + blank + aged + unrelated + interval-free + unmaterialized rows", () => {
    const db = freshDb();
    seedRetired(db);

    const counts = sweepMemoryOrphans(db, { ...BASE, retiredRetentionDays: 30 });

    expect(counts.retired_entities).toBe(2);
    expect(entityIds(db)).toEqual([
      "active-blank",
      "peer",
      "r-interval",
      "r-note",
      "r-obs",
      "r-recent",
      "r-related",
    ]);
    expect(relationRows(db)).toEqual(["r-related>peer"]);
  });

  it("measures the window from updated_at (the retirement instant), not created_at", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO memory_entities (id, vault_id, entity_type, name, observations, materialize, created_at, updated_at, status)
       VALUES ('retired-lately', 'main', 't', 'n', '', 1, ?, ?, 'retired')`,
    ).run(OLD, RECENT);
    expect(sweepMemoryOrphans(db, { ...BASE, retiredRetentionDays: 30 }).retired_entities).toBe(0);
    expect(entityIds(db)).toEqual(["retired-lately"]);
  });
});

describe("sweepMemoryOrphans — opt-in class: entities of a vault that is no longer registered", () => {
  function seedVaults(db: Database): void {
    entity(db, { id: "live", vault: "main", observations: "x" });
    entity(db, { id: "gone-old", vault: "gone", observations: "x" });
    entity(db, { id: "gone-old2", vault: "gone", observations: "" });
    entity(db, { id: "gone-recent", vault: "gone", updatedAt: RECENT });
    relation(db, "live", "gone-old"); // cross-vault edge: goes with the entity, as delete_entity would
    relation(db, "gone-old", "gone-old2");
    relation(db, "live", "gone-recent");
    interval(db, "gone-old");
    interval(db, "live");
  }

  it("does nothing unless removedVaultRetentionDays is set", () => {
    const db = freshDb();
    seedVaults(db);
    const counts = sweepMemoryOrphans(db, { ...BASE, registeredVaultIds: ["main"] });
    expect(counts.removed_vault_entities).toBe(0);
    expect(entityIds(db)).toEqual(["gone-old", "gone-old2", "gone-recent", "live"]);
  });

  it("deletes aged entities of an unregistered vault together with their relations and intervals", () => {
    const db = freshDb();
    seedVaults(db);

    const counts = sweepMemoryOrphans(db, {
      ...BASE,
      removedVaultRetentionDays: 30,
      registeredVaultIds: ["main"],
    });

    expect(counts).toMatchObject({
      removed_vault_entities: 2,
      removed_vault_relations: 2,
      removed_vault_intervals: 1,
    });
    expect(entityIds(db)).toEqual(["gone-recent", "live"]);
    expect(relationRows(db)).toEqual(["live>gone-recent"]);
    expect(intervalOwners(db)).toEqual(["live"]);
  });

  it("works the same on a connection with foreign_keys = ON (children are removed explicitly, not left to the cascade)", () => {
    const db = freshDb(true);
    entity(db, { id: "live", vault: "main", observations: "x" });
    entity(db, { id: "gone-old", vault: "gone", observations: "x" });
    relation(db, "live", "gone-old");
    interval(db, "gone-old");
    const counts = sweepMemoryOrphans(db, {
      ...BASE,
      removedVaultRetentionDays: 30,
      registeredVaultIds: ["main"],
    });
    expect(counts).toMatchObject({
      removed_vault_entities: 1,
      removed_vault_relations: 1,
      removed_vault_intervals: 1,
    });
    expect(entityIds(db)).toEqual(["live"]);
  });

  it("refuses to run the class when the registered-vault list is empty or absent (never 'everything is removed')", () => {
    const db = freshDb();
    seedVaults(db);
    for (const registeredVaultIds of [[], undefined] as const) {
      const counts = sweepMemoryOrphans(db, {
        ...BASE,
        removedVaultRetentionDays: 30,
        ...(registeredVaultIds !== undefined ? { registeredVaultIds } : {}),
      });
      expect(counts.removed_vault_entities).toBe(0);
    }
    expect(entityIds(db)).toEqual(["gone-old", "gone-old2", "gone-recent", "live"]);
  });
});

describe("sweepMemoryOrphans — dryRun, idempotency, batching", () => {
  function seedEverything(db: Database): void {
    entity(db, { id: "a" });
    entity(db, { id: "r-gone", status: "retired" });
    entity(db, { id: "gone-old", vault: "gone", observations: "x" });
    relation(db, "a", "ghost");
    relation(db, "a", "gone-old");
    interval(db, "ghost");
    interval(db, "gone-old");
  }
  const OPTS = {
    ...BASE,
    retiredRetentionDays: 30,
    removedVaultRetentionDays: 30,
    registeredVaultIds: ["main"],
  };
  const snapshot = (db: Database) => ({
    e: entityIds(db),
    r: relationRows(db),
    i: intervalOwners(db),
  });

  it("dryRun reports the same counts as a real run and changes nothing", () => {
    const dry = freshDb();
    seedEverything(dry);
    const before = snapshot(dry);
    const dryCounts = sweepMemoryOrphans(dry, { ...OPTS, dryRun: true });
    expect(snapshot(dry)).toEqual(before);
    expect(dryCounts.dry_run).toBe(true);

    const real = freshDb();
    seedEverything(real);
    const realCounts = sweepMemoryOrphans(real, OPTS);
    expect(realCounts.dry_run).toBe(false);
    expect({ ...dryCounts, dry_run: undefined, batches: undefined }).toEqual({
      ...realCounts,
      dry_run: undefined,
      batches: undefined,
    });
    expect(dryCounts.dangling_relations).toBe(1);
    expect(dryCounts.retired_entities).toBe(1);
    expect(dryCounts.removed_vault_entities).toBe(1);
    expect(snapshot(real)).not.toEqual(before);
  });

  it("a second run finds nothing", () => {
    const db = freshDb();
    seedEverything(db);
    sweepMemoryOrphans(db, OPTS);
    const after = snapshot(db);
    const again = sweepMemoryOrphans(db, OPTS);
    expect(again).toMatchObject({
      dangling_relations: 0,
      dangling_intervals: 0,
      retired_entities: 0,
      removed_vault_entities: 0,
      removed_vault_relations: 0,
      removed_vault_intervals: 0,
    });
    expect(snapshot(db)).toEqual(after);
  });

  it("deletes in bounded batches, each in its own labelled write transaction", () => {
    const db = freshDb();
    entity(db, { id: "a" });
    for (let i = 0; i < 25; i++) relation(db, "a", `ghost${i}`);
    const labels: string[] = [];

    const counts = sweepMemoryOrphans(db, {
      ...BASE,
      batchSize: 10,
      hooks: { onLockWait: (label) => labels.push(label) },
    });

    expect(counts.dangling_relations).toBe(25);
    expect(counts.batches).toBe(3); // 10 + 10 + 5
    expect(counts.truncated).toBe(false);
    expect(labels).toEqual(["memory_orphan_sweep", "memory_orphan_sweep", "memory_orphan_sweep"]);
    expect(relationRows(db)).toEqual([]);
  });

  it("takes no write lock at all when there is nothing to delete", () => {
    const db = freshDb();
    entity(db, { id: "a" });
    relation(db, "a", "a");
    const labels: string[] = [];
    const counts = sweepMemoryOrphans(db, {
      ...BASE,
      retiredRetentionDays: 30,
      hooks: { onLockWait: (label) => labels.push(label) },
    });
    expect(counts.batches).toBe(0);
    expect(labels).toEqual([]);
  });

  it("stops at maxBatches, reports truncated, and the next run picks up the remainder", () => {
    const db = freshDb();
    entity(db, { id: "a" });
    for (let i = 0; i < 25; i++) relation(db, "a", `ghost${i}`);

    const first = sweepMemoryOrphans(db, { ...BASE, batchSize: 10, maxBatches: 2 });
    expect(first.dangling_relations).toBe(20);
    expect(first.truncated).toBe(true);
    expect(relationRows(db)).toHaveLength(5);

    const second = sweepMemoryOrphans(db, { ...BASE, batchSize: 10, maxBatches: 2 });
    expect(second.dangling_relations).toBe(5);
    expect(second.truncated).toBe(false);
  });

  it("a failing batch rolls back and leaves earlier batches committed", () => {
    const db = freshDb();
    entity(db, { id: "a" });
    for (let i = 0; i < 5; i++) relation(db, "a", `ghost${i}`);
    // Abort a DELETE once fewer than 4 relations remain, i.e. from the third row on.
    db.exec(
      `CREATE TRIGGER boom BEFORE DELETE ON memory_relations
       WHEN (SELECT COUNT(*) FROM memory_relations) < 4
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() => sweepMemoryOrphans(db, { ...BASE, batchSize: 2 })).toThrow(/boom/);
    // batch 1 (2 rows) committed; batch 2 aborted by the trigger and rolled back whole.
    expect(relationRows(db)).toHaveLength(3);
  });
});

describe("registerMemoryOrphanSweep", () => {
  it("registers its own scheduler job at the configured interval and reports each run", async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      entity(db, { id: "a" });
      relation(db, "a", "ghost");
      const sched = new Scheduler();
      const seen: number[] = [];
      registerMemoryOrphanSweep(sched, {
        db,
        intervalMs: 60_000,
        batchSize: 100,
        now: () => NOW,
        onSweep: (c) => seen.push(c.dangling_relations),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(61_000);
      await sched.stop();
      expect(seen).toEqual([1]);
      expect(sched.stats().map((s) => s.job)).toContain("memory-orphan-sweep");
    } finally {
      vi.useRealTimers();
    }
  });
});
