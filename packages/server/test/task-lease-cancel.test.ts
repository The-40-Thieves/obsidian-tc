// A task attempt that has been superseded must not be able to write, a late cancel must not hide a
// real result, a cancelled index run must actually stop, and a shutdown must not abandon a task that
// `startTask` launched without anyone awaiting it.
//
// The shape of the original defect: `index_vault` ignored `ctx.signal`, so a cancelled run kept
// going; its heartbeat stopped at the abort, the lease lapsed, the runner's tick reclaimed the row
// under the SAME lease owner (`serve:<pid>`), and two executions then raced on one job. Because the
// owner string was the only guard, the stale attempt's `complete()` and its unguarded
// `recordOutcome()` were indistinguishable from the live one's, and a job that did finish projected
// as `cancelled` because the cancel flag was still set, suppressing the result it held.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import {
  TASK_CALL_JOB_TYPE,
  TASK_CALL_PAYLOAD_VERSION,
  type TaskCallPayload,
  toMcpTask,
} from "../src/mcp/tasks";
import { JobQueue, runJob } from "../src/scheduler/job-queue";
import { makeJobRunner } from "../src/scheduler/job-runner";
import { makeStartTask, makeTaskCallHandler } from "../src/scheduler/task-call-runner";
import { openMemoryDb } from "./helpers";
import { makeM2Vault } from "./m2-helpers";

const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  if (!cond()) throw new Error("condition never held");
};

function payload(tool: string): TaskCallPayload {
  return {
    v: TASK_CALL_PAYLOAD_VERSION,
    tool,
    args: {},
    caller: "alice",
    authenticated: true,
    scopes: ["*"],
    vaultId: "v1",
    vaultBound: false,
  };
}

describe("lease token: a superseded attempt cannot write", () => {
  it("recordOutcome and complete are refused for a lease that was reclaimed", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const clock = { t: 1_000 };
    const queue = new JobQueue(db, { now: () => clock.t, leaseMs: 100 });
    const job = queue.enqueue(TASK_CALL_JOB_TYPE, {
      owner: { vaultId: "v1", caller: "alice" },
      maxAttempts: 1,
      payload: payload("t"),
    });
    expect(queue.claimById(job.id, "attempt-A")).not.toBeNull();
    clock.t += 1_000; // attempt A's lease lapsed
    expect(queue.claim({ leaseOwner: "attempt-B" })?.leaseOwner).toBe("attempt-B");

    const stale = { ok: true as const, result: { from: "A" } };
    expect(queue.recordOutcome(job.id, stale, "attempt-A")).toBe(false);
    expect(queue.get(job.id)?.outcome).toBeNull();
    expect(queue.complete(job.id, "attempt-A")).toBe(false);

    expect(queue.recordOutcome(job.id, { ok: true, result: { from: "B" } }, "attempt-B")).toBe(
      true,
    );
    expect(queue.complete(job.id, "attempt-B")).toBe(true);
    expect(queue.get(job.id)?.outcome).toEqual({ ok: true, result: { from: "B" } });
  });
});

describe("two attempts of one task call, one lease owner string", () => {
  function setup() {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const clock = { t: 1_000 };
    const queue = new JobQueue(db, { now: () => clock.t, leaseMs: 1_000 });
    const releases: Array<() => void> = [];
    const state = { started: 0 };
    const registry = new ToolRegistry();
    registry.register({
      name: "slow",
      description: "gated",
      inputSchema: z.object({}),
      requiredScopes: [],
      handler: async () => {
        const me = ++state.started;
        await new Promise<void>((r) => releases.push(r));
        return { attempt: me };
      },
    } as unknown as ToolDefinition);
    const deps = { registry, db, acl, queue };
    const job = queue.enqueue(TASK_CALL_JOB_TYPE, {
      owner: { vaultId: "v1", caller: "alice" },
      maxAttempts: 1,
      payload: payload("slow"),
    });
    const runner = makeJobRunner({
      queue,
      leaseOwner: "serve:1", // the SAME string startTask uses, as in plane-wiring
      handlers: new Map([[TASK_CALL_JOB_TYPE, makeTaskCallHandler(deps)]]),
    });
    return { queue, clock, releases, state, deps, job, runner };
  }

  it("the stale attempt finishing LAST cannot overwrite the live attempt's result", async () => {
    const s = setup();
    makeStartTask(s.deps, "serve:1")(s.job.id);
    await until(() => s.state.started === 1);
    s.clock.t += 5_000;
    const drained = s.runner.drainOnce(new AbortController().signal);
    await until(() => s.state.started === 2);
    s.releases[1]?.();
    await drained;
    expect(s.queue.get(s.job.id)).toMatchObject({
      state: "complete",
      outcome: { ok: true, result: { attempt: 2 } },
    });
    s.releases[0]?.();
    await tick(30);
    expect(s.queue.get(s.job.id)?.outcome).toEqual({ ok: true, result: { attempt: 2 } });
  });

  it("the stale attempt finishing FIRST cannot complete the job out from under the live one", async () => {
    const s = setup();
    makeStartTask(s.deps, "serve:1")(s.job.id);
    await until(() => s.state.started === 1);
    s.clock.t += 5_000;
    const drained = s.runner.drainOnce(new AbortController().signal);
    await until(() => s.state.started === 2);
    s.releases[0]?.();
    await tick(30);
    expect(s.queue.get(s.job.id)).toMatchObject({ state: "running", outcome: null });
    s.releases[1]?.();
    await drained;
    expect(s.queue.get(s.job.id)).toMatchObject({
      state: "complete",
      outcome: { ok: true, result: { attempt: 2 } },
    });
  });
});

describe("a late cancel does not hide a finished result", () => {
  const base = {
    id: "j",
    type: TASK_CALL_JOB_TYPE,
    class: TASK_CALL_JOB_TYPE,
    attempt: 1,
    maxAttempts: 1,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpoint: undefined,
    payload: undefined,
    idempotencyKey: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
    vaultId: "v1",
    caller: "alice",
  };

  it("complete + cancel requested -> completed, carrying the result", () => {
    const task = toMcpTask({
      ...base,
      state: "complete",
      cancelRequested: true,
      outcome: { ok: true, result: { done: true } },
    });
    expect(task.status).toBe("completed");
    expect(task.result).toEqual({ done: true });
  });

  it("failed + cancel requested is still cancelled (the abort the cancel caused)", () => {
    const task = toMcpTask({
      ...base,
      state: "failed",
      cancelRequested: true,
      lastError: "aborted",
      outcome: null,
    });
    expect(task.status).toBe("cancelled");
  });
});

describe("index_vault honours its signal", () => {
  it("a signal that fires mid-run aborts the call and records no partial stats", async () => {
    const ac = new AbortController();
    const base = fakeEmbeddingProvider({ dimensions: 32 });
    const provider = {
      ...base,
      embed: async (texts: string[]) => {
        ac.abort();
        return base.embed(texts);
      },
    };
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`n${i}.md`] = `# N${i}\n\nbody number ${i}`;
    let completed = 0;
    let errored = 0;
    const v = makeM2Vault({
      files,
      provider,
      onIndexVaultComplete: () => completed++,
      onIndexVaultError: () => errored++,
    });
    try {
      const r = await v.call("index_vault", { vault: v.id }, { signal: ac.signal });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("aborted");
      expect(completed).toBe(0);
      expect(errored).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});

describe("immediate task runs are tracked and drained at shutdown", () => {
  it("drain aborts a running task, waits for it, and leaves the row lease-recoverable", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const queue = new JobQueue(db);
    let sawAbort = false;
    const registry = new ToolRegistry();
    registry.register({
      name: "slow",
      description: "waits for its signal",
      inputSchema: z.object({}),
      requiredScopes: [],
      handler: (_in: unknown, ctx: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          ctx.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("stopped"));
          });
        }),
    } as unknown as ToolDefinition);
    const job = queue.enqueue(TASK_CALL_JOB_TYPE, {
      owner: { vaultId: "v1", caller: "alice" },
      maxAttempts: 1,
      payload: payload("slow"),
    });
    const startTask = makeStartTask({ registry, db, acl, queue }, "serve:1");
    startTask(job.id);
    await until(() => queue.get(job.id)?.state === "running");
    await tick(20);

    await startTask.drain();

    expect(sawAbort).toBe(true);
    // Not failed: a shutdown is not the caller's cancel, so the row stays for lease recovery.
    expect(queue.get(job.id)?.state).toBe("running");
    expect(queue.get(job.id)?.cancelRequested).toBe(false);
    // And a second drain has nothing to wait for.
    await startTask.drain();
  });

  it("runJob reports an externally aborted run as interrupted and writes no terminal state", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const queue = new JobQueue(db);
    const job = queue.enqueue("x", { maxAttempts: 1 });
    const claimed = queue.claim({ leaseOwner: "w" });
    if (!claimed) throw new Error("no claim");
    const outer = new AbortController();
    const run = runJob(
      queue,
      claimed,
      "w",
      (_j, { signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("x")))),
      { signal: outer.signal },
    );
    outer.abort();
    expect((await run).outcome).toBe("interrupted");
    expect(queue.get(job.id)?.state).toBe("running");
  });
});

describe("a job cancelled before it started never runs", () => {
  function rig() {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const queue = new JobQueue(db);
    const handlerRuns = { n: 0 };
    const handler = async (): Promise<void> => {
      handlerRuns.n++;
    };
    const enqueue = () =>
      queue.enqueue(TASK_CALL_JOB_TYPE, {
        owner: { vaultId: "v1", caller: "alice" },
        maxAttempts: 1,
        payload: payload("t"),
      });
    return { db, queue, handlerRuns, handler, enqueue };
  }
  const ranIfClaimed = async (
    r: ReturnType<typeof rig>,
    claim: () => ReturnType<JobQueue["claim"]>,
  ) => {
    const claimed = claim();
    if (claimed) await runJob(r.queue, claimed, "w", r.handler);
  };

  it("enqueue -> requestCancel -> claim -> runJob: handler_runs=0, projected cancelled", async () => {
    const r = rig();
    const job = r.enqueue();
    r.queue.requestCancel(job.id);
    await ranIfClaimed(r, () => r.queue.claim({ leaseOwner: "w" }));
    expect(r.handlerRuns.n).toBe(0);
    const after = r.queue.get(job.id);
    if (!after) throw new Error("job vanished");
    expect(toMcpTask(after).status).toBe("cancelled");
  });

  it("claimById (the immediate-start path) refuses it the same way", async () => {
    const r = rig();
    const job = r.enqueue();
    r.queue.requestCancel(job.id);
    await ranIfClaimed(r, () => r.queue.claimById(job.id, "w"));
    expect(r.handlerRuns.n).toBe(0);
    const after = r.queue.get(job.id);
    if (!after) throw new Error("job vanished");
    expect(toMcpTask(after).status).toBe("cancelled");
  });

  it("a cancel that lands between the claim and runJob is honoured before the handler is invoked", async () => {
    const r = rig();
    const job = r.enqueue();
    const claimed = r.queue.claim({ leaseOwner: "w" });
    if (!claimed) throw new Error("no claim");
    r.queue.requestCancel(job.id);
    const out = await runJob(r.queue, claimed, "w", r.handler);
    expect(r.handlerRuns.n).toBe(0);
    expect(out.outcome).toBe("failed");
    const after = r.queue.get(job.id);
    if (!after) throw new Error("job vanished");
    expect(toMcpTask(after).status).toBe("cancelled");
  });

  it("the runner's tick (claim) skips a cancelled job and still claims the next one", () => {
    const r = rig();
    const cancelled = r.enqueue();
    const live = r.enqueue();
    r.queue.requestCancel(cancelled.id);
    expect(r.queue.claim({ leaseOwner: "w" })?.id).toBe(live.id);
    expect(r.queue.get(cancelled.id)?.state).toBe("failed");
  });

  it("makeStartTask does not run a task cancelled before it started", async () => {
    const r = rig();
    const registry = new ToolRegistry();
    let ran = 0;
    registry.register({
      name: "t",
      description: "x",
      inputSchema: z.object({}),
      requiredScopes: [],
      handler: () => {
        ran++;
        return {};
      },
    } as unknown as ToolDefinition);
    const job = r.enqueue();
    r.queue.requestCancel(job.id);
    const start = makeStartTask({ registry, db: r.db, acl, queue: r.queue }, "serve:1");
    start(job.id);
    // Let the run settle on its own: a drain would abort it and hide whether it was ever refused.
    await until(
      () => r.queue.get(job.id)?.state !== "queued" && r.queue.get(job.id)?.state !== "running",
    );
    await start.drain();
    expect(ran).toBe(0);
    const after = r.queue.get(job.id);
    if (!after) throw new Error("job vanished");
    expect(toMcpTask(after).status).toBe("cancelled");
  });
});
