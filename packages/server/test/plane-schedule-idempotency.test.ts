import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { registerPlaneSchedule } from "../src/runtime/plane-wiring";
import { JobQueue } from "../src/scheduler/job-queue";
import { openMemoryDb } from "./helpers";

const JOBS = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260723_002_jobs.sql", import.meta.url)),
  "utf8",
);
const INIT = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const OWNER = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260728_001_jobs_owner.sql", import.meta.url)),
  "utf8",
);
const OUTCOME = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260728_002_jobs_outcome.sql", import.meta.url)),
  "utf8",
);

/** Minimal Scheduler stand-in: capture the registered run() so the test can fire it directly
 *  instead of waiting on a 240-minute interval. */
function captureScheduler() {
  const runs: Array<(signal: AbortSignal) => void> = [];
  const notAborted = new AbortController().signal;
  return {
    scheduler: {
      register: (s: { run: (signal: AbortSignal) => void }) => runs.push(s.run),
    } as never,
    fire: () => {
      for (const r of runs) r(notAborted);
    },
  };
}

describe("THE-700: a failed plane period must be re-enqueueable", () => {
  it("re-enqueues synthesis after a FAILED run instead of no-opping for the rest of the week", () => {
    const db = openMemoryDb();
    runMigrations(db, [
      { version: "20260519_001", sql: INIT },
      { version: "20260723_002", sql: JOBS },
      { version: "20260728_001", sql: OWNER },
      { version: "20260728_002", sql: OUTCOME },
    ]);
    const jobQueue = new JobQueue(db);
    const { scheduler, fire } = captureScheduler();
    registerPlaneSchedule(scheduler, {
      plane: { enabled: true, intervalMinutes: 240 },
      roles: {
        extract: async () => ({ text: "", model: "m" }),
        synthesize: async () => ({ text: "", model: "m" }),
        judge: async () => ({ text: "", model: "m" }),
      },
      jobQueue,
    });

    fire();
    const first = db.prepare("SELECT id FROM jobs WHERE type = 'synthesis'").all() as {
      id: string;
    }[];
    expect(first).toHaveLength(1);

    // The production failure mode: a cold-start timeout leaves the row terminal.
    db.prepare(
      "UPDATE jobs SET state = 'failed', last_error = 'gateway timed out' WHERE type = 'synthesis'",
    ).run();

    // Next scheduled tick, same ISO week — the same idempotency key.
    fire();
    const after = db.prepare("SELECT id, state FROM jobs WHERE type = 'synthesis'").all() as {
      id: string;
      state: string;
    }[];

    // Without replaceIfTerminal this is still the single `failed` row: enqueue() dedups against a
    // terminal row and returns it, so the whole week is locked out.
    expect(after).toHaveLength(1);
    expect(after[0]?.state).toBe("queued");
    expect(after[0]?.id).not.toBe(first[0]?.id);
  });
});

// THE-723. The test above pins the FAILED half of THE-700 and nothing else, which is how the
// COMPLETE half regressed unnoticed: `replaceIfTerminal` replaces `complete` too, so every
// scheduler tick deleted the plane's own successful once-per-period work and re-ran it. On the
// live store `audit` — keyed DAILY, succeeding on every run — wrote 243 rows in a day.
describe("THE-723: a COMPLETED plane period must NOT be re-enqueued", () => {
  function bootPlane() {
    const db = openMemoryDb();
    runMigrations(db, [
      { version: "20260519_001", sql: INIT },
      { version: "20260723_002", sql: JOBS },
      { version: "20260728_001", sql: OWNER },
      { version: "20260728_002", sql: OUTCOME },
    ]);
    const jobQueue = new JobQueue(db);
    const { scheduler, fire } = captureScheduler();
    registerPlaneSchedule(scheduler, {
      plane: { enabled: true, intervalMinutes: 240 },
      roles: {
        extract: async () => ({ text: "", model: "m" }),
        synthesize: async () => ({ text: "", model: "m" }),
        judge: async () => ({ text: "", model: "m" }),
      },
      jobQueue,
    });
    return { db, fire };
  }

  for (const type of ["synthesis", "audit"] as const) {
    it(`does not replace a completed ${type} row on the next tick`, () => {
      const { db, fire } = bootPlane();

      fire();
      const first = db.prepare(`SELECT id FROM jobs WHERE type = '${type}'`).all() as {
        id: string;
      }[];
      expect(first).toHaveLength(1);

      // The period's work finished successfully.
      db.prepare(`UPDATE jobs SET state = 'complete' WHERE type = '${type}'`).run();

      // Next tick, SAME period — the key must still dedup.
      fire();
      const after = db.prepare(`SELECT id, state FROM jobs WHERE type = '${type}'`).all() as {
        id: string;
        state: string;
      }[];

      expect(after).toHaveLength(1);
      expect(after[0]?.state).toBe("complete");
      expect(after[0]?.id).toBe(first[0]?.id);
    });
  }
});
