// THE-715: `job_schedule` accumulated 2,979 orphan rows against 7 real ones.
//
// The cause is a SQLite quirk that reads like a constraint and is not: NOT NULL is **not** implied
// by PRIMARY KEY unless the table is WITHOUT ROWID. `name TEXT PRIMARY KEY` therefore admits
// unlimited NULLs, so every UPSERT with a null name INSERTED instead of updating, silently, while
// the named rows kept working perfectly. Nothing broke, which is why it ran for weeks.
//
// Fixed at both ends, and both are needed:
//   - `scheduler.ts` declares the column NOT NULL, so a store created from here on cannot reach
//     the state. That is CREATE TABLE IF NOT EXISTS, so it reaches ONLY new stores.
//   - the maintenance sweep prunes NULL-name rows, which is what repairs the stores already in it.
//
// The guard test at the bottom is the one that matters operationally: `job_schedule` is created by
// the scheduler at RUNTIME, not by a migration, so a provisioned-but-unscheduled database does not
// have the table — and an unguarded DELETE would take the entire sweep down with "no such table".
import { describe, expect, it } from "vitest";
import { runMaintenanceSweep } from "../src/db/maintenance";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

/** The PERMISSIVE schema, exactly as pre-THE-715 stores carry it. Reproduced verbatim rather than
 *  imported, because the point is that an existing store keeps this shape forever — the fixed DDL
 *  in scheduler.ts is `IF NOT EXISTS` and never rewrites it. */
const LEGACY_DDL =
  "CREATE TABLE job_schedule (name TEXT PRIMARY KEY, last_run_at INTEGER, last_success_at INTEGER, next_run_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0)";

const FIXED_DDL =
  "CREATE TABLE job_schedule (name TEXT NOT NULL PRIMARY KEY, last_run_at INTEGER, last_success_at INTEGER, next_run_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0)";

function db(ddl?: string): Database {
  const d = openMemoryDb();
  provisionCacheDb(d);
  if (ddl) d.exec(ddl);
  return d;
}

const sweep = (d: Database) =>
  runMaintenanceSweep(d, {
    now: () => 1_800_000_000_000,
    eventLogDays: 30,
    jobsCompleteDays: 7,
    jobsFailedDays: 30,
  });

describe("the SQLite quirk this ticket exists for", () => {
  it("PRIMARY KEY alone does NOT imply NOT NULL — the legacy schema accepts many NULL names", () => {
    // If this ever starts throwing, SQLite changed its behaviour and the whole ticket is moot.
    // Asserting it directly means the fix rests on a demonstrated property, not on folklore.
    const d = db(LEGACY_DDL);
    for (let i = 0; i < 3; i++)
      d.prepare("INSERT INTO job_schedule (name, next_run_at) VALUES (NULL, ?)").run(i);
    expect((d.prepare("SELECT COUNT(*) AS n FROM job_schedule").get() as { n: number }).n).toBe(3);
    d.close?.();
  });

  it("the FIXED schema refuses a null name outright", () => {
    const d = db(FIXED_DDL);
    expect(() =>
      d.prepare("INSERT INTO job_schedule (name, next_run_at) VALUES (NULL, ?)").run(1),
    ).toThrow();
    d.close?.();
  });
});

describe("the maintenance sweep repairs an existing store", () => {
  it("deletes NULL-name rows, counts them, and leaves named rows untouched", () => {
    const d = db(LEGACY_DDL);
    for (let i = 0; i < 5; i++)
      d.prepare("INSERT INTO job_schedule (name, next_run_at) VALUES (NULL, ?)").run(i);
    for (const n of ["maintenance-sweep", "plane-enqueue"])
      d.prepare("INSERT INTO job_schedule (name, next_run_at) VALUES (?, 1)").run(n);

    const counts = sweep(d);
    expect(counts.orphan_schedule_rows).toBe(5);

    const rows = d.prepare("SELECT name FROM job_schedule ORDER BY name").all() as {
      name: string;
    }[];
    expect(rows.map((r) => r.name)).toEqual(["maintenance-sweep", "plane-enqueue"]);
    d.close?.();
  });

  it("is 0 on the second sweep — the intended end state, not an inert arm", () => {
    const d = db(LEGACY_DDL);
    d.prepare("INSERT INTO job_schedule (name, next_run_at) VALUES (NULL, 1)").run();
    expect(sweep(d).orphan_schedule_rows).toBe(1);
    expect(sweep(d).orphan_schedule_rows).toBe(0);
    d.close?.();
  });

  it("does NOT crash when job_schedule does not exist", () => {
    // The operationally important one. `job_schedule` is created by the scheduler at RUNTIME, not
    // by a migration, so a provisioned database whose scheduler never ran has no such table. An
    // unguarded DELETE throws "no such table" and takes every OTHER sweep arm down with it —
    // turning a cosmetic cleanup into an outage of idempotency-key pruning, event-log retention and
    // job retention all at once.
    const d = db();
    expect(
      (
        d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='job_schedule'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    const counts = sweep(d);
    expect(counts.orphan_schedule_rows).toBe(0);
    // And the rest of the sweep still ran rather than being aborted.
    expect(counts).toHaveProperty("idempotency_keys");
    expect(counts).toHaveProperty("event_log");
    d.close?.();
  });
});
