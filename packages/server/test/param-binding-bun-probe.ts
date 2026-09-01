// THE-665 — bun:sqlite leg of the parameter-binding conformance gate.
//
// Must run under `bun` (not vitest/Node): it exercises the real `bun:sqlite` adapter
// (src/db/bun-sqlite.ts), which only resolves under the Bun runtime — a static or dynamic
// `import("bun:sqlite")` throws under Node. See test/param-binding.test.ts, which spawns this
// script and asserts on its JSON stdout, mirroring test/otel-lazy-load.test.ts +
// eval/perf/otel-lazy-probe.ts.
//
// Prints ONE line of JSON: { rawBareKey, rawPositional, jobRow, scheduleRow }.
//   - rawBareKey / rawPositional: the STORED ROW (not a count) from binding a two-column `@id,@name`
//     insert with a bare-key object vs. a positional `?` insert on a scratch table. This is the
//     minimal reproduction of THE-665: bun:sqlite accepts the bare-key object without throwing but
//     silently binds every column to NULL.
//   - jobRow: the row `JobQueue.enqueue()` actually persists, through the real adapter + real
//     `jobs` migration (db/provision.ts) — this is the exact call site the ticket reports broken.
//   - scheduleRow: the row `Scheduler`'s durable persist path actually writes to `job_schedule`,
//     through the same real adapter — the second reported call site.
import { openBunSqlite } from "../src/db/bun-sqlite";
import { provisionCacheDb } from "../src/db/provision";
import { JobQueue } from "../src/scheduler/job-queue";
import { Scheduler } from "../src/scheduler/scheduler";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll for the scheduler's first persisted tick instead of guessing a wall-clock budget. Mirrors
 *  the vi.waitFor conversion in test/param-binding.test.ts's runIntegrationProbe -- this script
 *  runs as a plain `bun` subprocess (no vitest, no `vi.waitFor`), so the same "poll until true or
 *  fail loudly" shape is hand-rolled here instead. Checking `last_run_at` specifically (not mere
 *  row existence) matters: persistRunStart and the run-completion persist() are two separate
 *  writes, and a row can exist with `last_run_at` still NULL between them. */
async function waitForScheduleRow(
  db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
  name: string,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = db.prepare("SELECT * FROM job_schedule WHERE name = ?").get(name) as
      | Record<string, unknown>
      | undefined;
    if (row?.last_run_at != null) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `schedule row for "${name}" did not persist last_run_at within ${timeoutMs}ms`,
      );
    }
    await sleep(intervalMs);
  }
}

async function main(): Promise<void> {
  // --- raw adapter-level probe: the exact bind style job-queue.ts/scheduler.ts used BEFORE this
  // fix (bare-key object against an `@name` statement), vs. the fix (positional `?`). ---
  const raw = await openBunSqlite(":memory:");
  raw.exec("CREATE TABLE probe (id TEXT, name TEXT)");
  raw.prepare("INSERT INTO probe (id, name) VALUES (@id, @name)").run({
    id: "bare-key",
    name: "bare-key-name",
  });
  const rawBareKey = raw.prepare("SELECT * FROM probe WHERE rowid = 1").get();
  raw.prepare("INSERT INTO probe (id, name) VALUES (?, ?)").run("positional", "positional-name");
  const rawPositional = raw.prepare("SELECT * FROM probe WHERE rowid = 2").get();
  raw.close?.();

  // --- integration-level probe: the real call sites, real migrated schema. ---
  const db = await openBunSqlite(":memory:");
  provisionCacheDb(db);

  const queue = new JobQueue(db, { now: () => 1_700_000_000_000 });
  const job = queue.enqueue("contradiction", {
    payload: { note: "a.md" },
    idempotencyKey: "probe-key-1",
    owner: { vaultId: "main", caller: "probe" },
  });
  const jobRow = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);

  const sched = new Scheduler({ db, now: () => 1_700_000_000_000 });
  sched.register({ name: "probe-tick", intervalMs: 20, run: () => {} });
  sched.start();
  await waitForScheduleRow(db, "probe-tick");
  await sched.stop();
  const scheduleRow = db.prepare("SELECT * FROM job_schedule WHERE name = ?").get("probe-tick");

  db.close?.();

  console.log(JSON.stringify({ rawBareKey, rawPositional, jobRow, scheduleRow }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
