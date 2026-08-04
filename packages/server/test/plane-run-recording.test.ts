// THE-716: job_runs was empty while jobs completed, and the reason was a refactor seam, not a bug
// in the recorder.
//
// `SleepTimePlane.runJob` records every run — and production never calls it. THE-625 item 3 moved
// synthesis/audit/note-quality onto the DURABLE job queue, where each is wrapped by
// `wrapPlaneJob` so the runner's dead-letter/retry sees a THROW instead of an `ok:false` boolean.
// The run-recording did not come across with them, so the only path that records is the one
// nothing uses. That is why `derived.liveness` reported job_runs as `silent`: writer enabled,
// zero rows, for the life of the deployment.
//
// The cases below are chosen for what job_runs is FOR. A run log that only captures successes
// answers no question worth asking — you consult it when something failed — so the failure paths
// are the load-bearing tests here, not the happy one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { type JobResult, wrapPlaneJob } from "../src/plane/plane";
import type { JobHandler } from "../src/scheduler/job-runner";
import { openMemoryDb } from "./helpers";

const JOB_RUNS_DDL =
  "CREATE TABLE job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, ok INTEGER NOT NULL, detail TEXT);";

interface RunRow {
  job: string;
  ok: number;
  detail: string | null;
  started_at: number;
  finished_at: number;
}

function setup() {
  const db = openMemoryDb();
  db.exec(JOB_RUNS_DDL);
  let t = 1_000;
  return { db, rec: { db, now: () => (t += 10) } };
}
// The durable runner calls handlers as (job, ctx); wrapPlaneJob's closure ignores both, so the
// tests invoke it the way the runner does rather than pretending the arity is zero.
const invoke = (h: JobHandler) => h({} as never, {} as never);

/** The first recorded run, asserted to exist. Clearer than a non-null assertion at each use: if
 *  nothing was recorded the failure names that, rather than a null-property TypeError. */
function firstRun(db: ReturnType<typeof openMemoryDb>): RunRow {
  const r = rows(db);
  expect(r.length).toBeGreaterThan(0);
  return r[0] as RunRow;
}

const rows = (db: ReturnType<typeof openMemoryDb>) =>
  db
    .prepare("SELECT job, ok, detail, started_at, finished_at FROM job_runs ORDER BY id")
    .all() as RunRow[];

describe("wrapPlaneJob records to job_runs (THE-716)", () => {
  it("records a successful run with its detail", async () => {
    const { db, rec } = setup();
    const handler = wrapPlaneJob(
      "note-quality",
      async (): Promise<JobResult> => ({ ok: true, detail: { per_vault: 3 } }),
      rec,
    );
    await invoke(handler);
    expect(rows(db)).toHaveLength(1);
    const first = firstRun(db);
    expect(first).toMatchObject({ job: "note-quality", ok: 1 });
    expect(JSON.parse(first.detail ?? "{}")).toEqual({ per_vault: 3 });
    expect(first.finished_at).toBeGreaterThan(first.started_at);
  });

  // The whole point of the ticket. A job that reports ok:false is turned into a throw for the
  // durable runner — and if the row is written AFTER the throw, it is never written at all.
  it("records ok=0 BEFORE converting ok:false into the runner's throw", async () => {
    const { db, rec } = setup();
    const handler = wrapPlaneJob(
      "synthesis",
      async (): Promise<JobResult> => ({ ok: false, detail: { error: "gateway timeout" } }),
      rec,
    );
    await expect(invoke(handler)).rejects.toThrow(/synthesis job failed/);
    expect(rows(db)).toHaveLength(1);
    const first = firstRun(db);
    expect(first.ok).toBe(0);
    expect(first.detail).toContain("gateway timeout");
  });

  // A job that throws outright is still a run, and it is the one you most want in the log.
  it("records ok=0 when the job THROWS, and rethrows unchanged", async () => {
    const { db, rec } = setup();
    const boom = new Error("disk full");
    const handler = wrapPlaneJob(
      "audit",
      async () => {
        throw boom;
      },
      rec,
    );
    await expect(invoke(handler)).rejects.toThrow(boom);
    expect(rows(db)).toHaveLength(1);
    const first = firstRun(db);
    expect(first).toMatchObject({ job: "audit", ok: 0 });
    expect(first.detail).toContain("disk full");
  });

  it("still runs the job when job_runs does not exist — recording is best-effort", async () => {
    // A store predating the plane migration must not lose its jobs to a logging table.
    const db = openMemoryDb();
    let ran = false;
    const handler = wrapPlaneJob(
      "synthesis",
      async (): Promise<JobResult> => {
        ran = true;
        return { ok: true };
      },
      { db, now: () => 1 },
    );
    await invoke(handler);
    expect(ran).toBe(true);
  });

  it("a logging failure never fails a job that succeeded", async () => {
    const { rec } = setup();
    // Table dropped after setup: the INSERT will throw inside the recorder.
    rec.db.exec("DROP TABLE job_runs;");
    const handler = wrapPlaneJob(
      "note-quality",
      async (): Promise<JobResult> => ({ ok: true }),
      rec,
    );
    await expect(invoke(handler)).resolves.toBeUndefined();
  });

  it("records each run separately across repeated invocations", async () => {
    const { db, rec } = setup();
    const handler = wrapPlaneJob("audit", async (): Promise<JobResult> => ({ ok: true }), rec);
    await invoke(handler);
    await invoke(handler);
    expect(rows(db)).toHaveLength(2);
  });

  // The cases above build job_runs from a hand-written DDL, which pins behaviour but NOT that the
  // column names still match what ships. This one runs the real migration chain: if a future
  // migration renames a column, the recorder's INSERT breaks and its best-effort catch would
  // swallow it silently — leaving job_runs empty again for exactly the original reason.
  it("records against the SHIPPED migration chain, not just a hand-written table", async () => {
    const db = openMemoryDb();
    runMigrations(
      db,
      CACHE_MIGRATION_FILES.map((f) => ({
        version: versionOf(f),
        sql: readFileSync(
          fileURLToPath(new URL(`../src/migrations/${f}`, import.meta.url)),
          "utf8",
        ),
      })),
    );
    const handler = wrapPlaneJob(
      "audit",
      async (): Promise<JobResult> => ({ ok: true, detail: { checked: 1 } }),
      { db, now: () => 42 },
    );
    await invoke(handler);
    const r = db.prepare("SELECT job, ok FROM job_runs").all() as { job: string; ok: number }[];
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ job: "audit", ok: 1 });
  });
});
