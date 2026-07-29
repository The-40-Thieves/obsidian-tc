// THE-665 — parameter-binding conformance gate.
//
// `bun:sqlite`'s Statement.run() does NOT throw on a bare-key object bound against an `@name` (or
// `:name` / `$name`) SQL statement — it silently binds every named parameter to NULL. `node:sqlite`
// and `better-sqlite3` both accept the bare-key form correctly, and the whole suite runs on
// `node:sqlite` by default (test/helpers.ts), so this divergence was never exercised until it broke
// every durable job enqueue under the production (Bun) runtime.
//
// This gate exists so that class of bug can never hide again: it exercises the real db/*.ts
// adapters against the real `jobs` + `job_schedule` schema through the real call sites
// (JobQueue.enqueue, Scheduler's durable persist path), on all three adapters this repo supports,
// and asserts the STORED VALUES — never a row count. A row-count assertion is exactly what let the
// original bug through (see THE-665's own writeup): the INSERT succeeds, a row exists, and every
// column on it is NULL.
//
// bun:sqlite can only be exercised by actually running under Bun (a dynamic `import("bun:sqlite")`
// throws under Node), so that leg spawns `test/param-binding-bun-probe.ts` as a real `bun` process
// and asserts on its JSON stdout — mirroring test/otel-lazy-load.test.ts + eval/perf/otel-lazy-probe.ts.
//
// Watched failing (THE-665 PR): with job-queue.ts/scheduler.ts reverted to the pre-fix `@name` +
// bare-key-object bind style, the bun leg's job/schedule assertions fail — job-queue's INSERT hits
// `jobs.type`'s NOT NULL constraint and throws (SqliteError), and scheduler.ts's swallowed-by-design
// catch silently inserts an all-NULL, unbounded stream of `job_schedule` rows (verified directly
// against the adapter in isolation — every tick fails its ON CONFLICT(name) match because `name` is
// NULL, so it INSERTs a fresh row instead of upserting). Both are red on the unpatched code and green
// after switching to positional `?` binds.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "../src/db/node-better-sqlite3";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { JobQueue } from "../src/scheduler/job-queue";
import { Scheduler } from "../src/scheduler/scheduler";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exercises the real call sites (JobQueue.enqueue, Scheduler's durable persist) against a real
 *  adapter + the real migrated schema, and returns the STORED rows for both. */
async function runIntegrationProbe(db: Database): Promise<{
  jobRow: Record<string, unknown> | undefined;
  scheduleRow: Record<string, unknown> | undefined;
}> {
  provisionCacheDb(db);
  const queue = new JobQueue(db, { now: () => 1_700_000_000_000 });
  const job = queue.enqueue("contradiction", {
    payload: { note: "a.md" },
    idempotencyKey: "probe-key-1",
    owner: { vaultId: "main", caller: "probe" },
  });
  const jobRow = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as
    | Record<string, unknown>
    | undefined;

  const sched = new Scheduler({ db, now: () => 1_700_000_000_000 });
  sched.register({ name: "probe-tick", intervalMs: 20, run: () => {} });
  sched.start();
  await sleep(120);
  await sched.stop();
  const scheduleRow = db.prepare("SELECT * FROM job_schedule WHERE name = ?").get("probe-tick") as
    | Record<string, unknown>
    | undefined;

  return { jobRow, scheduleRow };
}

function expectCorrectJobRow(jobRow: Record<string, unknown> | undefined): void {
  // A row-count check ("a row exists") is exactly what let THE-665 through — every field below
  // must be checked individually, because the original bug produced a row with every bound column
  // NULL (only the inline SQL literals `'queued'`/`0` survived).
  expect(jobRow).toBeDefined();
  expect(jobRow?.type).toBe("contradiction");
  expect(jobRow?.class).toBe("contradiction");
  expect(jobRow?.state).toBe("queued");
  expect(jobRow?.max_attempts).toBe(5);
  expect(jobRow?.payload).toBe('{"note":"a.md"}');
  expect(jobRow?.idempotency_key).toBe("probe-key-1");
  expect(jobRow?.vault_id).toBe("main");
  expect(jobRow?.caller).toBe("probe");
  expect(jobRow?.created_at).toBe(1_700_000_000_000);
  expect(jobRow?.updated_at).toBe(1_700_000_000_000);
  expect(jobRow?.next_attempt_at).toBe(1_700_000_000_000);
}

function expectCorrectScheduleRow(scheduleRow: Record<string, unknown> | undefined): void {
  expect(scheduleRow).toBeDefined();
  expect(scheduleRow?.name).toBe("probe-tick");
  expect(scheduleRow?.last_run_at).toBe(1_700_000_000_000);
  expect(scheduleRow?.last_success_at).toBe(1_700_000_000_000);
  expect(scheduleRow?.next_run_at).toBe(1_700_000_000_020);
  expect(scheduleRow?.consecutive_failures).toBe(0);
}

describe("THE-665: parameter-binding conformance (node:sqlite)", () => {
  it("stores correct, non-null values for a bare-key object bound to a named-param statement", async () => {
    const db = await openNodeSqlite(":memory:");
    db.exec("CREATE TABLE probe (id TEXT, name TEXT)");
    db.prepare("INSERT INTO probe (id, name) VALUES (@id, @name)").run({
      id: "abc",
      name: "xyz",
    });
    expect(db.prepare("SELECT * FROM probe").get()).toEqual({ id: "abc", name: "xyz" });
  });

  it("JobQueue.enqueue + Scheduler persist store correct values end-to-end", async () => {
    const db = await openNodeSqlite(":memory:");
    const { jobRow, scheduleRow } = await runIntegrationProbe(db);
    expectCorrectJobRow(jobRow);
    expectCorrectScheduleRow(scheduleRow);
  });
});

describe("THE-665: parameter-binding conformance (better-sqlite3)", () => {
  it("stores correct, non-null values for a bare-key object bound to a named-param statement", async () => {
    const db = await openBetterSqlite3(":memory:");
    db.exec("CREATE TABLE probe (id TEXT, name TEXT)");
    db.prepare("INSERT INTO probe (id, name) VALUES (@id, @name)").run({
      id: "abc",
      name: "xyz",
    });
    expect(db.prepare("SELECT * FROM probe").get()).toEqual({ id: "abc", name: "xyz" });
  });

  it("JobQueue.enqueue + Scheduler persist store correct values end-to-end", async () => {
    const db = await openBetterSqlite3(":memory:");
    const { jobRow, scheduleRow } = await runIntegrationProbe(db);
    expectCorrectJobRow(jobRow);
    expectCorrectScheduleRow(scheduleRow);
  });
});

// bun:sqlite cannot be exercised in-process: vitest runs under Node, and `import("bun:sqlite")`
// throws there. Spawn a real `bun` process instead.
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

// Loud floor, deliberately OUTSIDE the skipIf block below: if `bun` is missing, THIS assertion
// fails (not skips), so the bun:sqlite leg of the gate cannot go silently missing the way the
// bug itself did. A gate that quietly reports "0 tests ran, all green" over an empty set is worse
// than no gate — see the gates skill and THE-665's own directive.
it("THE-665: bun is on PATH (required for the bun:sqlite leg of the param-binding gate)", () => {
  expect(bunAvailable).toBe(true);
});

describe.skipIf(!bunAvailable)("THE-665: parameter-binding conformance (bun:sqlite)", () => {
  const PROBE = fileURLToPath(new URL("./param-binding-bun-probe.ts", import.meta.url));

  interface ProbeResult {
    rawBareKey: { id: string | null; name: string | null };
    rawPositional: { id: string | null; name: string | null };
    jobRow: Record<string, unknown>;
    scheduleRow: Record<string, unknown>;
  }

  function runProbe(): ProbeResult {
    const r = spawnSync("bun", [PROBE], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) {
      throw new Error(`param-binding bun probe subprocess exited ${r.status}: ${r.stderr}`);
    }
    const line = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .at(-1);
    if (!line) throw new Error("param-binding bun probe produced no output");
    return JSON.parse(line) as ProbeResult;
  }

  let result: ProbeResult;
  beforeAll(() => {
    result = runProbe();
  });

  it("characterizes the bug: a bare-key object bound to a named-param statement is silently NULLed", () => {
    // This is the actual THE-665 defect, pinned so a future Bun upgrade that fixes it (or changes
    // it) is noticed rather than assumed. It is NOT what this repo's code does anymore — see the
    // next two tests — but it is why named bare-key binds must never come back.
    expect(result.rawBareKey).toEqual({ id: null, name: null });
  });

  it("positional `?` binds store correct, non-null values", () => {
    expect(result.rawPositional).toEqual({ id: "positional", name: "positional-name" });
  });

  it("JobQueue.enqueue + Scheduler persist store correct values end-to-end", () => {
    expectCorrectJobRow(result.jobRow);
    expectCorrectScheduleRow(result.scheduleRow);
  });
});
