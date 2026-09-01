// THE-926 — regex-worker.ts's readiness cache used to latch `capable = false` for the life of the
// process after ONE failed ping. A ping failure can be a transient hiccup (GC pause, resource
// pressure under load), not proof the runtime can never run the eval worker — but latching it
// meant every subsequent searchRegex call fell back to the inline scan (no per-exec timeout) with
// no way to recover short of a process restart. This file pins the fix: a failed probe is retried
// after UNAVAILABLE_COOLDOWN_MS instead of trusted forever.
//
// Own file because `vi.mock("node:worker_threads", ...)` is hoisted per-module (same reason
// perf-collectors-lock-cleanup.test.ts gives for its own `vi.mock("node:fs", ...)`), and each test
// needs a FRESH module instance (regex-worker.ts's `capable`/`worker`/`capableCheckedAt` are
// module-scoped) — `vi.resetModules()` + a dynamic re-import per test, rather than one shared
// import, is what makes that isolation real.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Controls how the next constructed FakeWorker answers a ping: "hang" never replies (the
 *  caller's own timeout must fire, mirroring a genuinely wedged worker); "respond" replies
 *  immediately, mirroring a healthy worker. */
let mode: "hang" | "respond" = "hang";
let constructedCount = 0;

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    constructedCount++;
  }
  unref(): void {}
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
  postMessage(msg: { id: number; ping?: boolean }): void {
    if (mode === "respond") {
      // A real worker's reply is asynchronous relative to postMessage; a microtask is the
      // smallest faithful stand-in and needs no timer advance to observe.
      queueMicrotask(() => this.emit("message", { id: msg.id, hits: [] }));
    }
    // mode === "hang": never reply.
  }
}

vi.mock("node:worker_threads", () => ({ Worker: FakeWorker }));

beforeEach(() => {
  mode = "hang";
  constructedCount = 0;
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("regexWorkerAvailable readiness cache (THE-926)", () => {
  it("a failed ping is NOT cached forever — it is re-probed after the cooldown", async () => {
    const { regexWorkerAvailable } = await import("../src/search/regex-worker");
    let clock = 0;
    const now = () => clock;

    // First probe: the worker hangs, so the caller's own 1s ping timeout must fire.
    const first = regexWorkerAvailable(now);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe(false);
    expect(constructedCount).toBe(1);

    // Well within the cooldown: cached `false` returned WITHOUT constructing another worker.
    clock += 10;
    expect(await regexWorkerAvailable(now)).toBe(false);
    expect(constructedCount).toBe(1);

    // Past the cooldown, and the worker now behaves: a fresh probe is attempted and succeeds.
    mode = "respond";
    clock += 30_000;
    expect(await regexWorkerAvailable(now)).toBe(true);
    expect(constructedCount).toBe(2);
  });

  it("a successful probe latches permanently — no re-probe even long after", async () => {
    mode = "respond";
    const { regexWorkerAvailable } = await import("../src/search/regex-worker");
    let clock = 0;
    const now = () => clock;

    expect(await regexWorkerAvailable(now)).toBe(true);
    expect(constructedCount).toBe(1);

    // A runtime that answered once stays trusted — even a runtime that would now hang is never
    // asked again, because a working worker does not need re-verifying on cadence.
    mode = "hang";
    clock += 10_000_000;
    expect(await regexWorkerAvailable(now)).toBe(true);
    expect(constructedCount).toBe(1);
  });

  it("defaults `now` to Date.now when the caller supplies nothing (production call shape)", async () => {
    const { regexWorkerAvailable } = await import("../src/search/regex-worker");
    const p = regexWorkerAvailable();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(false);
  });
});
