// THE-458 (audit #6): the contradiction drain's single-flight promise semantics. The in-flight batch
// is a promise, so a concurrent caller (shutdown) joins it instead of racing db.close() against a live
// write. The old boolean guard let a concurrent drain call return immediately mid-batch.

import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import type { GatewayRoles } from "../src/plane/gateway";
import type { IndexedChunk } from "../src/plane/jobs/contradiction";
import { makeContradictionDrainer } from "../src/plane/jobs/contradiction-drain";

const stubDb = {} as unknown as Database;
const stubRoles = {} as unknown as GatewayRoles;
const chunk = (id: string): { vaultId: string; chunk: IndexedChunk } => ({
  vaultId: "v",
  chunk: { id, path: `${id}.md`, content: id } as IndexedChunk,
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("makeContradictionDrainer (audit #6)", () => {
  it("is single-flight: a concurrent drainOnce joins the in-flight batch, not a second run", async () => {
    const gate = deferred();
    let calls = 0;
    const queue = [chunk("a"), chunk("b")];
    const d = makeContradictionDrainer({
      db: stubDb,
      roles: stubRoles,
      queue,
      batchSize: 100,
      check: (async () => {
        calls += 1;
        await gate.promise; // hold the batch in-flight
        return { checked: 0, flagged: 0, skipped: 0 };
      }) as any,
    });

    const first = d.drainOnce();
    const second = d.drainOnce(); // called while the first batch is in-flight
    expect(d.inFlight).not.toBeNull();
    expect(first).toBe(second); // SAME promise -> the concurrent caller awaits the running batch
    gate.resolve();
    await first;
    expect(calls).toBe(1); // exactly one batch ran despite two drainOnce calls
    expect(d.inFlight).toBeNull(); // idle after the batch settles
  });

  it("inFlight resolves before the queue is cleared, so shutdown can await a live write", async () => {
    const gate = deferred();
    let finished = false;
    const d = makeContradictionDrainer({
      db: stubDb,
      roles: stubRoles,
      queue: [chunk("a")],
      batchSize: 100,
      check: (async () => {
        await gate.promise;
        finished = true;
        return { checked: 0, flagged: 0, skipped: 0 };
      }) as any,
    });
    void d.drainOnce();
    const inFlight = d.inFlight;
    expect(inFlight).not.toBeNull();
    // Shutdown awaits inFlight; it must not resolve until the batch's write completes.
    let awaited = false;
    const waiter = inFlight?.then(() => {
      awaited = true;
    });
    await Promise.resolve();
    expect(awaited).toBe(false);
    expect(finished).toBe(false);
    gate.resolve();
    await waiter;
    expect(finished).toBe(true); // the write ran to completion before inFlight resolved
  });

  it("drainToEmpty loops the bounded worker across multiple batches", async () => {
    const batches: number[] = [];
    const queue = Array.from({ length: 250 }, (_, i) => chunk(`c${i}`));
    const d = makeContradictionDrainer({
      db: stubDb,
      roles: stubRoles,
      queue,
      batchSize: 100,
      check: (async (_ctx: unknown, _v: string, chunks: IndexedChunk[]) => {
        batches.push(chunks.length);
        return { checked: 0, flagged: 0, skipped: 0 };
      }) as any,
    });
    await d.drainToEmpty();
    // 250 chunks at batchSize 100 -> three bounded batches (100, 100, 50), queue emptied.
    expect(batches).toEqual([100, 100, 50]);
    expect(queue.length).toBe(0);
    expect(d.inFlight).toBeNull();
  });

  it("is a no-op without a gateway (roles null)", async () => {
    let calls = 0;
    const d = makeContradictionDrainer({
      db: stubDb,
      roles: null,
      queue: [chunk("a")],
      batchSize: 100,
      check: (async () => {
        calls += 1;
        return { checked: 0, flagged: 0, skipped: 0 };
      }) as any,
    });
    await d.drainOnce();
    await d.drainToEmpty();
    expect(calls).toBe(0);
    expect(d.inFlight).toBeNull();
  });

  it("routes a check failure to onError and never rejects", async () => {
    const errors: string[] = [];
    const d = makeContradictionDrainer({
      db: stubDb,
      roles: stubRoles,
      queue: [chunk("a")],
      batchSize: 100,
      onError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
      check: (async () => {
        throw new Error("judge down");
      }) as any,
    });
    await d.drainOnce(); // must not reject
    expect(errors).toEqual(["judge down"]);
  });
});
