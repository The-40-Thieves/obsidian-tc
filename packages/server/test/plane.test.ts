import { describe, expect, it } from "vitest";
import { type Job, SleepTimePlane } from "../src/plane/plane";
import { openMemoryDb } from "./helpers";

describe("sleep-time plane (local job runner)", () => {
  it("runs registered jobs, records job_runs, and isolates a failing job", async () => {
    const db = openMemoryDb();
    db.exec(
      "CREATE TABLE job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, ok INTEGER NOT NULL, detail TEXT);",
    );
    const okJob: Job = { name: "ok", run: async () => ({ ok: true, detail: { x: 1 } }) };
    const boomJob: Job = {
      name: "boom",
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const plane = new SleepTimePlane().register(okJob).register(boomJob);
    expect(plane.list()).toEqual(["ok", "boom"]);

    let t = 0;
    const res = await plane.runAll({ db, roles: null, now: () => ++t });
    expect(res.ok?.ok).toBe(true);
    expect(res.boom?.ok).toBe(false);
    expect(String(res.boom?.detail?.error)).toContain("kaboom");

    const runs = db.prepare("SELECT job, ok FROM job_runs ORDER BY id").all() as Array<{
      job: string;
      ok: number;
    }>;
    expect(runs).toEqual([
      { job: "ok", ok: 1 },
      { job: "boom", ok: 0 },
    ]);
  });
});
