// Orphan sweep for the memory graph: memory_entities, memory_relations and
// memory_observation_intervals. Runs as its own job on the shared scheduler (see
// registerMemoryOrphanSweep) rather than as an arm of the cache.db sweep, because it has its own
// cadence, its own config block and its own dry-run switch.
//
// MEMORY ROWS ARE USER DATA. An entity created with materialize:false exists nowhere but this
// table, so the default posture is to delete only rows that no reader can reach, and everything
// beyond that is opt-in and age-gated:
//
//   default (maintenance.memoryOrphans.enabled)
//     dangling_relations   a relation whose source OR target entity row no longer exists. Every
//                          reader joins memory_entities (relationsForEntity, the graph walk), so
//                          such a row is invisible. Produced by a connection without
//                          `foreign_keys = ON` (the pragma is per-connection, and the ON DELETE
//                          CASCADE that would remove it does not run).
//     dangling_intervals   a memory_observation_intervals row whose entity is gone. deleteEntity
//                          removes relations explicitly but leaves intervals to the FK cascade,
//                          so this is the same failure one table over.
//
//   opt-in, each behind its own retention window (unset = class off)
//     retired_entities     status = 'retired' AND observations blank AND no interval rows AND no
//                          relation in either direction AND no materialized note (vault_path IS
//                          NULL) AND updated_at older than the window. A retired entity that still
//                          carries any fact, edge or note is user data and is never touched.
//     removed_vault_*      entities whose vault_id is not in the LIVE vault registry, and older
//                          than the window, together with the relations and intervals that hang off
//                          them. Off by default because "not registered right now" is also what a
//                          config typo or an unmounted vault looks like; refused outright when the
//                          registry is empty.
//
// NEVER deleted: an entity that is merely unconnected. A standalone entity, with or without
// observations, is valid.
//
// Bounded: each batch is one BEGIN IMMEDIATE transaction of at most `batchSize` rows, so the write
// lock is held for one small delete at a time, and a class stops after `maxBatches` batches (the
// remainder is picked up next run; `truncated` reports it).
import type { Scheduler } from "../scheduler/scheduler";
import { tableExists } from "./introspect";
import { inWriteTransaction, type WriteTxnHooks } from "./txn";
import type { Database } from "./types";

/** The per-class row counts in `MemoryOrphanCounts`, in the order they are reported. Also the closed
 *  set of values of the metric counter's `class` label. */
export const MEMORY_ORPHAN_CLASSES = [
  "dangling_relations",
  "dangling_intervals",
  "retired_entities",
  "removed_vault_entities",
  "removed_vault_relations",
  "removed_vault_intervals",
] as const;
export type MemoryOrphanClass = (typeof MEMORY_ORPHAN_CLASSES)[number];

export interface MemoryOrphanCounts {
  dangling_relations: number;
  dangling_intervals: number;
  retired_entities: number;
  removed_vault_entities: number;
  /** Relations (either end) deleted together with a removed-vault entity. */
  removed_vault_relations: number;
  /** Interval rows deleted together with a removed-vault entity. */
  removed_vault_intervals: number;
  /** Write transactions used across all classes. Always 0 for a dry run. */
  batches: number;
  /** A class hit `maxBatches` with a full last batch, so rows may remain for the next run. */
  truncated: boolean;
  dry_run: boolean;
}

export interface MemoryOrphanOptions {
  now: number;
  /** Rows per write transaction. */
  batchSize: number;
  /** Batches per class per run. Default 100. */
  maxBatches?: number;
  /** Absent -> the retired-entity class is off. */
  retiredRetentionDays?: number;
  /** Absent -> the removed-vault class is off. */
  removedVaultRetentionDays?: number;
  /** The live vault ids. Empty or absent -> the removed-vault class does not run. */
  registeredVaultIds?: readonly string[];
  /** Count without deleting. Classes are counted independently: a row eligible under two classes
   *  appears in both here, whereas a real run's first class to reach it removes it. */
  dryRun?: boolean;
  hooks?: WriteTxnHooks;
}

const DEFAULT_MAX_BATCHES = 100;
const DAY_MS = 86_400_000;

const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** A class of orphan rows: `pick` is a `SELECT <rowid> ...` over `table` that names them. Delete,
 *  probe and count are all derived from it, so the three can never disagree about membership. */
interface RowClass {
  table: string;
  pick: string;
  args: (string | number)[];
}

const num = (db: Database, sql: string, ...args: (string | number)[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n;

/** The write-transaction loop shared by every class: `step(limit)` deletes up to `limit` rows in
 *  one transaction and returns how many. A short batch means the class is drained. `probe` is a
 *  read-only check run first, so a sweep with nothing to do never takes the write lock. */
function drain(
  db: Database,
  opts: MemoryOrphanOptions,
  stats: { batches: number; truncated: boolean },
  probe: () => boolean,
  step: (limit: number) => number,
): number {
  if (!probe()) return 0;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = inWriteTransaction(db, "memory_orphan_sweep", () => step(opts.batchSize), opts.hooks);
    stats.batches += 1;
    total += n;
    if (n < opts.batchSize) return total;
  }
  stats.truncated = true;
  return total;
}

/** Delete (or, for a dry run, count) every row of a simple class. */
function sweepClass(
  db: Database,
  opts: MemoryOrphanOptions,
  stats: { batches: number; truncated: boolean },
  c: RowClass,
): number {
  if (opts.dryRun === true) return num(db, `SELECT COUNT(*) AS n FROM (${c.pick})`, ...c.args);
  return drain(
    db,
    opts,
    stats,
    () => db.prepare(`SELECT 1 FROM (${c.pick} LIMIT 1)`).get(...c.args) !== undefined,
    (limit) =>
      db.prepare(`DELETE FROM ${c.table} WHERE rowid IN (${c.pick} LIMIT ?)`).run(...c.args, limit)
        .changes,
  );
}

/** Delete (or, for `dryRun`, count) the orphan classes described in this file's header. Returns 0s
 *  without touching anything when the memory tables do not exist. A batch that throws rolls back
 *  whole and the error propagates; batches already committed stay committed. */
export function sweepMemoryOrphans(db: Database, opts: MemoryOrphanOptions): MemoryOrphanCounts {
  const out: MemoryOrphanCounts = {
    dangling_relations: 0,
    dangling_intervals: 0,
    retired_entities: 0,
    removed_vault_entities: 0,
    removed_vault_relations: 0,
    removed_vault_intervals: 0,
    batches: 0,
    truncated: false,
    dry_run: opts.dryRun === true,
  };
  if (!tableExists(db, "memory_entities") || !tableExists(db, "memory_relations")) return out;
  const hasIntervals = tableExists(db, "memory_observation_intervals");
  const stats = { batches: 0, truncated: false };

  // 1. Dangling children. Run first so a relation with a missing end is attributed here, not to
  //    the removed-vault class below.
  out.dangling_relations = sweepClass(db, opts, stats, {
    table: "memory_relations",
    pick: `SELECT r.rowid FROM memory_relations r
            WHERE NOT EXISTS (SELECT 1 FROM memory_entities e WHERE e.id = r.source_id)
               OR NOT EXISTS (SELECT 1 FROM memory_entities e WHERE e.id = r.target_id)`,
    args: [],
  });
  if (hasIntervals)
    out.dangling_intervals = sweepClass(db, opts, stats, {
      table: "memory_observation_intervals",
      pick: `SELECT i.rowid FROM memory_observation_intervals i
              WHERE NOT EXISTS (SELECT 1 FROM memory_entities e WHERE e.id = i.entity_id)`,
      args: [],
    });

  // 2. Entities of a vault that is no longer registered, with their relations and intervals.
  const live = opts.registeredVaultIds ?? [];
  if (opts.removedVaultRetentionDays !== undefined && live.length > 0) {
    const where = `vault_id NOT IN (${placeholders(live.length)}) AND updated_at < ?`;
    const args = [...live, opts.now - opts.removedVaultRetentionDays * DAY_MS];
    const pick = `SELECT rowid FROM memory_entities WHERE ${where}`;
    if (opts.dryRun === true) {
      const ids = `SELECT id FROM memory_entities WHERE ${where}`;
      out.removed_vault_entities = num(db, `SELECT COUNT(*) AS n FROM (${pick})`, ...args);
      out.removed_vault_relations = num(
        db,
        `SELECT COUNT(*) AS n FROM memory_relations WHERE source_id IN (${ids}) OR target_id IN (${ids})`,
        ...args,
        ...args,
      );
      if (hasIntervals)
        out.removed_vault_intervals = num(
          db,
          `SELECT COUNT(*) AS n FROM memory_observation_intervals WHERE entity_id IN (${ids})`,
          ...args,
        );
    } else {
      out.removed_vault_entities = drain(
        db,
        opts,
        stats,
        () => db.prepare(`SELECT 1 FROM (${pick} LIMIT 1)`).get(...args) !== undefined,
        (limit) => {
          const ids = (
            db
              .prepare(`SELECT id FROM memory_entities WHERE ${where} ORDER BY rowid LIMIT ?`)
              .all(...args, limit) as { id: string }[]
          ).map((r) => r.id);
          if (ids.length === 0) return 0;
          const inList = placeholders(ids.length);
          out.removed_vault_relations += db
            .prepare(
              `DELETE FROM memory_relations WHERE source_id IN (${inList}) OR target_id IN (${inList})`,
            )
            .run(...ids, ...ids).changes;
          if (hasIntervals)
            out.removed_vault_intervals += db
              .prepare(`DELETE FROM memory_observation_intervals WHERE entity_id IN (${inList})`)
              .run(...ids).changes;
          return db.prepare(`DELETE FROM memory_entities WHERE id IN (${inList})`).run(...ids)
            .changes;
        },
      );
    }
  }

  // 3. Retired entities with nothing left in them. Blank means only the whitespace JS `trim()`
  //    strips (SQLite's own trim() strips only spaces, so the set is spelled out).
  if (opts.retiredRetentionDays !== undefined)
    out.retired_entities = sweepClass(db, opts, stats, {
      table: "memory_entities",
      pick: `SELECT e.rowid FROM memory_entities e
              WHERE e.status = 'retired' AND e.updated_at < ? AND e.vault_path IS NULL
                AND TRIM(e.observations, char(32, 9, 10, 13)) = ''
                AND NOT EXISTS (SELECT 1 FROM memory_relations r
                                 WHERE r.source_id = e.id OR r.target_id = e.id)
                ${hasIntervals ? "AND NOT EXISTS (SELECT 1 FROM memory_observation_intervals i WHERE i.entity_id = e.id)" : ""}`,
      args: [opts.now - opts.retiredRetentionDays * DAY_MS],
    });

  out.batches = stats.batches;
  out.truncated = stats.truncated;
  return out;
}

export interface MemoryOrphanSweepDeps
  extends Omit<MemoryOrphanOptions, "now" | "registeredVaultIds"> {
  db: Database;
  intervalMs: number;
  /** Read at run time, so a vault added with add_vault after boot is not mistaken for a removed one. */
  listVaultIds?: () => readonly string[];
  now?: () => number;
  onSweep?: (counts: MemoryOrphanCounts) => void;
  onError?: (e: unknown) => void;
}

/** Register the sweep as its own job on the shared scheduler. */
export function registerMemoryOrphanSweep(scheduler: Scheduler, deps: MemoryOrphanSweepDeps): void {
  const { db, intervalMs, listVaultIds, now, onSweep, onError, ...opts } = deps;
  scheduler.register({
    name: "memory-orphan-sweep",
    intervalMs,
    run: () => {
      const counts = sweepMemoryOrphans(db, {
        ...opts,
        now: (now ?? Date.now)(),
        ...(listVaultIds !== undefined ? { registeredVaultIds: listVaultIds() } : {}),
      });
      onSweep?.(counts);
    },
    onError: (e) => onError?.(e),
  });
}
