// GH #995 fix round — SHUTDOWN_RECONCILE_OVERLAP: server-runtime.ts's close() previously released
// the leader lock (vault-lock.ts) the instant raceShutdownPhase's OWN drain settled, with no join
// surface for a still-running reconcile pass (gateReconcileByLeader's boot/promotion-triggered
// call, fire-and-forget by construction) — a successor could promote and start writing while this
// process's reconcile was still mid-walk. joinInFlightReconcile is the extracted, directly testable
// piece of that fix: it must actually WAIT for an in-flight run (bounded by a deadline) rather than
// returning "done" immediately regardless.
import { describe, expect, it } from "vitest";
import {
  joinInFlightReconcile,
  joinReconcileOrExit,
  raceShutdownPhase,
  raceShutdownPhaseOrExit,
  ShutdownTimeoutExitError,
} from "../src/runtime/shutdown-phase";

describe("joinInFlightReconcile — SHUTDOWN_RECONCILE_OVERLAP's join surface", () => {
  it("resolves immediately as 'done' when nothing is in flight", async () => {
    const outcome = await joinInFlightReconcile(undefined, 1000);
    expect(outcome).toBe("done");
  });

  it("waits for an in-flight run to settle rather than returning 'done' immediately", async () => {
    let resolved = false;
    let resolveRun!: () => void;
    const run = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const joined = joinInFlightReconcile(run, 5000).then((outcome) => {
      resolved = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Must NOT have resolved yet — a fire-and-forget (pre-fix) join would return "done" here
    // without ever looking at `run`'s own state.
    expect(resolved).toBe(false);
    resolveRun();
    expect(await joined).toBe("done");
    expect(resolved).toBe(true);
  });

  it("resolves 'done' even when the in-flight run REJECTS — a failed reconcile still must not block release forever", async () => {
    const run = Promise.reject(new Error("reconcile blew up"));
    const outcome = await joinInFlightReconcile(run, 1000);
    expect(outcome).toBe("done");
  });

  it("returns 'timeout' when the in-flight run outlives the deadline — the caller must not release the lock on this outcome", async () => {
    const run = new Promise<void>(() => {
      // never resolves within this test
    });
    const outcome = await joinInFlightReconcile(run, 30);
    expect(outcome).toBe("timeout");
  });
});

// GH #995 fix round 2, F3: joinReconcileOrExit must NEVER let a caller fall through to a lock
// release on a timeout, even when `exit` is a test double (or a genuinely delayed real
// process.exit under Bun) that returns instead of terminating the process.
describe("joinReconcileOrExit — F3: never falls through on a timeout, even if exit() returns", () => {
  it("resolves normally (no throw) when nothing is in flight", async () => {
    let exitCalled = false;
    await expect(
      joinReconcileOrExit(undefined, 1000, () => {
        exitCalled = true;
      }),
    ).resolves.toBeUndefined();
    expect(exitCalled).toBe(false);
  });

  it("resolves normally when the in-flight run settles within the deadline", async () => {
    let exitCalled = false;
    const run = Promise.resolve();
    await expect(
      joinReconcileOrExit(run, 1000, () => {
        exitCalled = true;
      }),
    ).resolves.toBeUndefined();
    expect(exitCalled).toBe(false);
  });

  it("calls exit(1) AND throws ShutdownTimeoutExitError on a timeout — a non-exiting exit() double cannot fall through to a caller that releases the lock next", async () => {
    const run = new Promise<void>(() => {
      // never resolves
    });
    let exitCode: number | undefined;
    await expect(
      joinReconcileOrExit(run, 20, (code) => {
        exitCode = code; // a test double: records the call but does NOT actually terminate
      }),
    ).rejects.toBeInstanceOf(ShutdownTimeoutExitError);
    expect(exitCode).toBe(1);
  });
});

// GH #995 fix round 2, F3: raceShutdownPhase itself now reports "timeout" as a distinct outcome
// (previously `void`, so a caller had no way to tell a real drain from a cut-off one), and
// raceShutdownPhaseOrExit gives it the SAME exit-then-throw treatment as joinReconcileOrExit —
// close() must never release the leader lock after EITHER kind of timeout.
describe("raceShutdownPhase / raceShutdownPhaseOrExit — F3", () => {
  function fastDrain() {
    return {
      scheduler: { stop: async () => {} },
      indexCoordinator: { idle: async () => {} },
      jobRunner: { drainOnce: async () => {} },
    };
  }
  function stuckDrain() {
    return {
      scheduler: { stop: async () => {} },
      indexCoordinator: {
        idle: () =>
          new Promise<void>(() => {
            // never resolves — models a coordinator still writing past the deadline
          }),
      },
      jobRunner: { drainOnce: async () => {} },
    };
  }

  it("returns 'done' when every drain settles inside the deadline", async () => {
    const outcome = await raceShutdownPhase({ ...fastDrain(), drainMs: 1000 });
    expect(outcome).toBe("done");
  });

  it("returns 'timeout' when the coordinator is still draining past the deadline", async () => {
    const outcome = await raceShutdownPhase({ ...stuckDrain(), drainMs: 20 });
    expect(outcome).toBe("timeout");
  });

  it("raceShutdownPhaseOrExit resolves normally on 'done'", async () => {
    let exitCalled = false;
    await expect(
      raceShutdownPhaseOrExit({ ...fastDrain(), drainMs: 1000 }, () => {
        exitCalled = true;
      }),
    ).resolves.toBeUndefined();
    expect(exitCalled).toBe(false);
  });

  it("raceShutdownPhaseOrExit calls exit(1) AND throws on 'timeout' — never falls through to a caller that releases the lock next", async () => {
    let exitCode: number | undefined;
    await expect(
      raceShutdownPhaseOrExit({ ...stuckDrain(), drainMs: 20 }, (code) => {
        exitCode = code;
      }),
    ).rejects.toBeInstanceOf(ShutdownTimeoutExitError);
    expect(exitCode).toBe(1);
  });
});
