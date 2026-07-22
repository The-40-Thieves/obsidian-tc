// THE-462 defect (b): the scheduler passed an AbortSignal to every job, and every job threw it
// away. `JobSpec.run` is typed `(signal: AbortSignal) => ...` and runJob passes `this.abort.signal`,
// but both real consumers were registered as zero-arg closures — so stop() aborted the scheduler's
// own waiting while the in-flight job body ran to completion regardless.
//
// The plumbing existed; nothing was plugged into it. These tests plug it in at the two natural
// cancellation points: between plane jobs, and between vault groups in a drain batch.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { GatewayRoles } from "../src/plane/gateway";
import type { IndexedChunk } from "../src/plane/jobs/contradiction";
import { makeContradictionDrainer } from "../src/plane/jobs/contradiction-drain";
import { SleepTimePlane } from "../src/plane/plane";
import { openMemoryDb } from "./helpers";

/** The plane introspects the schema before dispatching a job, so it needs a real db. */
function realDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}
const stubDb = {} as unknown as Database;
const stubRoles = {} as unknown as GatewayRoles;

describe("THE-462(b): jobs honour the AbortSignal", () => {
  it("SleepTimePlane.runAll stops before the next job once aborted", async () => {
    const ran: string[] = [];
    const ctrl = new AbortController();
    const plane = new SleepTimePlane();
    plane.register({
      name: "first",
      run: async () => {
        ran.push("first");
        ctrl.abort(); // shutdown lands while the first job is running
        return { ok: true } as never;
      },
    } as never);
    plane.register({
      name: "second",
      run: async () => {
        ran.push("second");
        return { ok: true } as never;
      },
    } as never);

    await plane.runAll({
      db: realDb(),
      roles: stubRoles,
      now: () => 0,
      signal: ctrl.signal,
    } as never);

    expect(ran).toEqual(["first"]);
  });

  it("SleepTimePlane.runAll runs every job when not aborted", async () => {
    const ran: string[] = [];
    const plane = new SleepTimePlane();
    for (const name of ["a", "b"]) {
      plane.register({
        name,
        run: async () => {
          ran.push(name);
          return { ok: true } as never;
        },
      } as never);
    }

    await plane.runAll({ db: realDb(), roles: stubRoles, now: () => 0 } as never);

    expect(ran).toEqual(["a", "b"]);
  });

  it("the contradiction drain stops between vault groups once aborted", async () => {
    const ctrl = new AbortController();
    const checked: string[] = [];
    const queue = [
      { vaultId: "v1", chunk: { id: "a", path: "a.md", content: "a" } as IndexedChunk },
      { vaultId: "v2", chunk: { id: "b", path: "b.md", content: "b" } as IndexedChunk },
      { vaultId: "v3", chunk: { id: "c", path: "c.md", content: "c" } as IndexedChunk },
    ];
    const d = makeContradictionDrainer({
      db: stubDb,
      roles: stubRoles,
      queue,
      batchSize: 100,
      check: (async (_ctx: unknown, vaultId: string) => {
        checked.push(vaultId);
        ctrl.abort(); // abort during the first group
        return { checked: 0, flagged: 0, skipped: 0 };
      }) as never,
    } as never);

    await d.drainOnce(ctrl.signal);

    expect(checked).toEqual(["v1"]);
  });

  it("the contradiction drain processes every group when not aborted", async () => {
    const checked: string[] = [];
    const queue = [
      { vaultId: "v1", chunk: { id: "a", path: "a.md", content: "a" } as IndexedChunk },
      { vaultId: "v2", chunk: { id: "b", path: "b.md", content: "b" } as IndexedChunk },
    ];
    const d = makeContradictionDrainer({
      db: stubDb,
      roles: stubRoles,
      queue,
      batchSize: 100,
      check: (async (_ctx: unknown, vaultId: string) => {
        checked.push(vaultId);
        return { checked: 0, flagged: 0, skipped: 0 };
      }) as never,
    } as never);

    await d.drainOnce();

    expect(checked).toEqual(["v1", "v2"]);
  });
});
