// GH #995 follow-up: search/indexing/embed-pace.ts's waitForIdle — the primitive the
// boot/promotion reconcile uses to pace its embed pass against live dispatch activity. Pure and
// dependency-free, so every case here drives it with an injected gate/clock/signal rather than any
// real timer or the real dispatch counter (that wiring is covered separately — see
// plane-wiring-reconcile-mapping.test.ts's bootEmbed cases and boot-embed-pacing-integration.test.ts).
import { describe, expect, it, vi } from "vitest";
import {
  type IdleGate,
  isBackgroundEmbedPaused,
  serializeAdmission,
  waitForIdle,
} from "../src/search/indexing/embed-pace";

/** A controllable IdleGate: `busy` flips isBusy(), `idleSince` is the epoch ms `idleForMs` treats
 *  as "activity last happened at". */
function fakeGate(): {
  gate: IdleGate;
  busy: { value: boolean };
  setIdleSince: (t: number) => void;
} {
  const busy = { value: false };
  let idleSince = 0;
  return {
    gate: {
      isBusy: () => busy.value,
      idleForMs: (now) => (idleSince === 0 ? Number.POSITIVE_INFINITY : now - idleSince),
    },
    busy,
    setIdleSince: (t: number) => {
      idleSince = t;
    },
  };
}

describe("waitForIdle (GH #995 follow-up)", () => {
  it("returns immediately when the gate is already idle long enough — no wait, no poll", async () => {
    const { gate, setIdleSince } = fakeGate();
    setIdleSince(0); // idleForMs -> Infinity, isBusy -> false
    const start = Date.now();
    await waitForIdle(gate, 2000, undefined, () => start);
    expect(isBackgroundEmbedPaused()).toBe(false);
  });

  it("waits while the gate reports busy, and resumes once it reports idle for idleMs", async () => {
    const { gate, busy, setIdleSince } = fakeGate();
    busy.value = true;
    setIdleSince(0);
    let now = 1_000_000;
    const clock = () => now;
    let pausedDuringWait = false;
    const p = waitForIdle(gate, 200, undefined, clock, 5).then(() => {
      // Resolved -> must no longer be flagged as paused.
      expect(isBackgroundEmbedPaused()).toBe(false);
    });
    // Give the poll loop a chance to enter its wait state before asserting on it.
    await new Promise((r) => setTimeout(r, 20));
    pausedDuringWait = isBackgroundEmbedPaused();
    expect(pausedDuringWait).toBe(true);
    // Flip to idle-since-now; the NEXT poll tick should see idleForMs === 0 < 200 and keep waiting.
    busy.value = false;
    setIdleSince(now);
    await new Promise((r) => setTimeout(r, 20));
    expect(isBackgroundEmbedPaused()).toBe(true); // still under idleMs
    // Advance the clock past idleMs; the next poll tick resolves.
    now += 250;
    await p;
  });

  it("exits promptly on an already-aborted signal, without ever polling", async () => {
    const { gate, busy, setIdleSince } = fakeGate();
    busy.value = true;
    setIdleSince(0);
    const controller = new AbortController();
    controller.abort();
    const before = isBackgroundEmbedPaused();
    await waitForIdle(gate, 2000, controller.signal);
    expect(isBackgroundEmbedPaused()).toBe(before); // never entered the waiting state
  });

  it("exits promptly when the signal aborts mid-wait", async () => {
    const { gate, busy, setIdleSince } = fakeGate();
    busy.value = true;
    setIdleSince(0);
    const controller = new AbortController();
    const started = Date.now();
    // Fix round (Codex review, LOW finding 4b): pollMs (5000) is deliberately LONGER than the
    // assertion bound (1000) below. The old version used pollMs=10 with a 2000ms bound — a poll
    // loop that ignored the abort event entirely would still pass, because the NEXT 10ms poll tick
    // would observe `signal.aborted` on its own and return well inside 2000ms. With pollMs=5000,
    // that fallback path cannot resolve in time: this only passes if the `abort` LISTENER itself
    // clears the pending sleep timer (sleepAbortable's `onAbort`), which is the actual behavior
    // under test.
    const p = waitForIdle(gate, 60_000, controller.signal, undefined, 5000);
    await new Promise((r) => setTimeout(r, 20));
    expect(isBackgroundEmbedPaused()).toBe(true);
    controller.abort();
    await p;
    expect(isBackgroundEmbedPaused()).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves promptly on a signal that aborts in the gap between the loop's aborted-check and sleepAbortable (fix round, medium finding 1)", async () => {
    // Fix round (Codex review on #1003 verify-r2, medium finding 1): sleepAbortable's
    // addEventListener("abort", ...) does not fire for a signal already aborted before the
    // listener was attached — DOM/Node's AbortSignal only dispatches "abort" at the moment
    // abort() runs. waitForIdle's loop checks `signal?.aborted` once per iteration, then calls
    // gate.isBusy() / gate.idleForMs() before ever reaching sleepAbortable — an abort landing
    // inside one of those gate calls lands exactly in that gap. Model it directly: gate.isBusy()
    // aborts the controller as a side effect on its second call (the first call, before the loop,
    // must stay "busy" so the loop is actually entered).
    const controller = new AbortController();
    let isBusyCalls = 0;
    const gate: IdleGate = {
      isBusy: () => {
        isBusyCalls += 1;
        if (isBusyCalls === 2) controller.abort();
        return true;
      },
      idleForMs: () => 0,
    };
    const started = Date.now();
    // pollMs deliberately huge (5000, same margin as the mid-wait abort test above): only passes
    // if sleepAbortable catches the already-aborted signal synchronously on entry, not by falling
    // through to a real timer tick.
    await waitForIdle(gate, 60_000, controller.signal, undefined, 5000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(isBackgroundEmbedPaused()).toBe(false);
  });
});

// Fix round (Codex review on #1003, HIGH finding 1): bounded fairness. Without `maxDeferMs`, an
// idle-quiet-window gate has no progress floor — see waitForIdle's own doc for the mechanism.
describe("waitForIdle — maxDeferMs bounded fairness (fix round, finding 1)", () => {
  // Fix round (Codex review on #1003 verify-r2, low finding 4): both tests below used real
  // wall-clock elapsed-time bounds against real setTimeout/setInterval ticks — a loaded runner
  // that stretches those intervals could fail a correct implementation (a false-fail, not a false
  // green, but still flake). vi's fake timers make every setTimeout/setInterval/Date.now() this
  // code touches virtual and advanced only by explicit `vi.advanceTimersByTimeAsync` calls, so the
  // elapsed bounds below are exact poll-tick arithmetic, not a race against real time.
  it("continuous polling faster than idleMs still makes progress at the maxDeferMs floor", async () => {
    vi.useFakeTimers();
    try {
      const { gate, setIdleSince } = fakeGate();
      // Simulate a client polling every 100ms with idleMs 200: dispatch activity resets the quiet
      // window every 100ms, so the plain idle check (busy=false, idleForMs>=idleMs) NEVER passes —
      // every poll tick sees idleForMs < 200. isBusy() itself stays false the whole time (a quick
      // poll call, not a long-running one), which is exactly what lets maxDeferMs's "admit once
      // isBusy() is false" branch fire instead of the harder busy-forever cap.
      setIdleSince(Date.now());
      const resetInterval = setInterval(() => {
        setIdleSince(Date.now());
      }, 100);
      const idleMs = 200;
      const maxDeferMs = 400;
      const started = Date.now();
      // Capture the fake clock's value the MOMENT the promise settles, in a `.then` — reading
      // Date.now() after the full `advanceTimersByTimeAsync` budget has been consumed would read
      // the whole 2000ms window regardless of when `p` actually resolved inside it.
      let resolvedAt = -1;
      const p = waitForIdle(gate, idleMs, undefined, undefined, 30, maxDeferMs).then(() => {
        resolvedAt = Date.now();
      });
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      clearInterval(resetInterval);
      const elapsed = resolvedAt - started;
      // Deterministic under fake timers — resolves at the 30ms poll tick that first crosses
      // maxDeferMs, never at idleMs's own quiet window (this traffic pattern never reaches it)
      // and never later than one extra poll tick past the floor.
      expect(elapsed).toBeGreaterThanOrEqual(maxDeferMs);
      expect(elapsed).toBeLessThan(maxDeferMs + 30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hung in-flight call (isBusy() never clears) still makes progress after the hard cap", async () => {
    vi.useFakeTimers();
    try {
      const { gate, busy, setIdleSince } = fakeGate();
      busy.value = true; // never clears — the hung-handler case
      setIdleSince(0);
      const idleMs = 200;
      const maxDeferMs = 200;
      const started = Date.now();
      let resolvedAt = -1;
      const p = waitForIdle(gate, idleMs, undefined, undefined, 30, maxDeferMs).then(() => {
        resolvedAt = Date.now();
      });
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      const elapsed = resolvedAt - started;
      // Hard cap is 2x maxDeferMs (embed-pace.ts's HARD_CAP_MULTIPLIER) — admitted unconditionally
      // there even though isBusy() never went false. Deterministic under fake timers: resolves at
      // the poll tick that first crosses the hard cap, never more than one tick late.
      expect(elapsed).toBeGreaterThanOrEqual(maxDeferMs * HARD_CAP_MULTIPLIER_FOR_TEST);
      expect(elapsed).toBeLessThan(maxDeferMs * HARD_CAP_MULTIPLIER_FOR_TEST + 30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("absent maxDeferMs preserves the old unbounded contract — no admission before a genuine quiet window", async () => {
    const { gate, busy, setIdleSince } = fakeGate();
    busy.value = true;
    setIdleSince(0);
    const controller = new AbortController();
    const p = waitForIdle(gate, 60_000, controller.signal, undefined, 10); // no maxDeferMs
    await new Promise((r) => setTimeout(r, 100));
    expect(isBackgroundEmbedPaused()).toBe(true); // still waiting — no floor kicked in
    controller.abort();
    await p;
  });
});

// Fix round (Codex review on #1003, HIGH finding 2): burst admission. Concurrent callers must not
// all pass the gate in the same microtask.
describe("serializeAdmission (fix round, finding 2)", () => {
  it("admits queued callers one at a time, each after a macrotask yield past the previous", async () => {
    const order: number[] = [];
    const calls = [1, 2, 3, 4].map((n) =>
      serializeAdmission(async () => {
        order.push(n);
        return n;
      }),
    );
    const results = await Promise.all(calls);
    expect(results).toEqual([1, 2, 3, 4]);
    // FIFO order preserved even though every call was issued in the same synchronous tick — that
    // is the exact shape of `concurrency` workers all calling pace() back to back.
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("a rejected admission does not poison the queue for callers behind it", async () => {
    const first = serializeAdmission(async () => {
      throw new Error("boom");
    });
    const second = serializeAdmission(async () => "ok");
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });
});

// Mirrors embed-pace.ts's own (unexported) HARD_CAP_MULTIPLIER — kept as a named constant here
// rather than a bare literal so the two tests above read as "hard cap = 2x maxDeferMs" and not an
// unexplained magic number.
const HARD_CAP_MULTIPLIER_FOR_TEST = 2;
