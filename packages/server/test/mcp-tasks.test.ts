// THE-583: the MCP Tasks extension over the THE-517 durable queue.
//
// Two things are under test and the second is the one that matters.
//
// The PROJECTION, because the queue's vocabulary and the extension's do not line up: three queue
// states collapse to `working`, and `cancelled` is not a queue state at all but a request flag plus
// a terminal state.
//
// The OWNERSHIP FILTER, because the queue holds internal maintenance work — reconcile,
// contradiction, synthesis, audit — whose `payload` and `last_error` carry vault paths and error
// text. Exposing `tasks/get` over it without isolation is a cross-vault read of server-operational
// detail, the class THE-563/THE-564 exist to prevent. Every negative case below is a leak that
// would otherwise be invisible: the queue would answer happily, and nothing would look wrong.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { findOwnedJob, type McpTaskOwner, toMcpTask } from "../src/mcp/tasks";
import { JobQueue } from "../src/scheduler/job-queue";
import { openMemoryDb } from "./helpers";

const OWNER: McpTaskOwner = { vaultId: "main", caller: "agent-1" };

function queue(): JobQueue {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return new JobQueue(db);
}

describe("toTask — projecting a queue job onto the extension vocabulary", () => {
  const base = {
    id: "j1",
    type: "t",
    class: "t",
    attempt: 0,
    maxAttempts: 5,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpoint: undefined,
    payload: undefined,
    idempotencyKey: null,
    lastError: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    vaultId: "main",
    caller: "agent-1",
    outcome: null,
  };

  it("collapses queued, running and retrying to `working`", () => {
    // A retry is the queue doing its job, not an outcome to poll on. Exposing it would leak the
    // retry policy into a client contract we would then have to keep.
    for (const state of ["queued", "running", "retrying"] as const) {
      expect(toMcpTask({ ...base, state, cancelRequested: false }).status).toBe("working");
    }
  });

  it("maps terminal states to completed / failed", () => {
    expect(toMcpTask({ ...base, state: "complete", cancelRequested: false }).status).toBe(
      "completed",
    );
    expect(toMcpTask({ ...base, state: "failed", cancelRequested: false }).status).toBe("failed");
  });

  it("reports `cancelled` only once the job actually STOPPED", () => {
    // The queue records cancellation as a request the runner honours at its next checkpoint.
    // Reporting `cancelled` while it is still running would tell the client the work has stopped
    // when it has not — the client would move on while the job kept mutating the vault.
    expect(toMcpTask({ ...base, state: "running", cancelRequested: true }).status).toBe("working");
    expect(toMcpTask({ ...base, state: "complete", cancelRequested: true }).status).toBe(
      "cancelled",
    );
    expect(toMcpTask({ ...base, state: "failed", cancelRequested: true }).status).toBe("cancelled");
  });

  it("carries the failure reason on a failed task and on nothing else", () => {
    const failed = toMcpTask({
      ...base,
      state: "failed",
      cancelRequested: false,
      lastError: "boom",
    });
    expect(failed.statusMessage).toBe("boom");
    // A cancelled task must not surface the runner's abort text as though it were a fault.
    expect(
      toMcpTask({ ...base, state: "failed", cancelRequested: true, lastError: "aborted" })
        .statusMessage,
    ).toBeUndefined();
    expect(
      toMcpTask({ ...base, state: "complete", cancelRequested: false }).statusMessage,
    ).toBeUndefined();
  });

  it("always carries ttlMs, which the schema makes REQUIRED and nullable", () => {
    // Not optional: omitting it produces a Task the extension schema rejects. Null is the honest
    // value — queue rows are durable and are not reaped on a clock.
    const t = toMcpTask({ ...base, state: "running", cancelRequested: false });
    expect(t).toHaveProperty("ttlMs");
    expect(t.ttlMs).toBeNull();
  });

  it("offers a poll interval only while working", () => {
    expect(
      toMcpTask({ ...base, state: "running", cancelRequested: false }).pollIntervalMs,
    ).toBeGreaterThan(0);
    expect(
      toMcpTask({ ...base, state: "complete", cancelRequested: false }).pollIntervalMs,
    ).toBeUndefined();
  });

  it("emits ISO timestamps, not epoch millis", () => {
    const t = toMcpTask({ ...base, state: "running", cancelRequested: false });
    expect(t.createdAt).toBe(new Date(base.createdAt).toISOString());
    expect(t.lastUpdatedAt).toBe(new Date(base.updatedAt).toISOString());
  });
});

describe("findOwnedJob — isolation", () => {
  it("finds a job enqueued FOR this caller", () => {
    const q = queue();
    const job = q.enqueue("caller_work", { owner: { vaultId: "main", caller: "agent-1" } });
    expect(findOwnedJob(q, job.id, OWNER)?.id).toBe(job.id);
  });

  it("HIDES internal maintenance work, which has no owner at all", () => {
    // Every existing enqueue call site is this case: reconcile, contradiction, synthesis, audit.
    // They are not the caller's tasks, and their failure text is server-operational detail.
    const q = queue();
    const internal = q.enqueue("reconcile");
    expect(internal.vaultId).toBeNull();
    expect(findOwnedJob(q, internal.id, OWNER)).toBeNull();
  });

  it("HIDES another VAULT's task", () => {
    const q = queue();
    const other = q.enqueue("caller_work", { owner: { vaultId: "agents", caller: "agent-1" } });
    expect(findOwnedJob(q, other.id, OWNER)).toBeNull();
  });

  it("HIDES another CALLER's task in the same vault", () => {
    const q = queue();
    const other = q.enqueue("caller_work", { owner: { vaultId: "main", caller: "agent-2" } });
    expect(findOwnedJob(q, other.id, OWNER)).toBeNull();
  });

  it("does not treat a null caller as a wildcard in either direction", () => {
    const q = queue();
    const anon = q.enqueue("caller_work", { owner: { vaultId: "main", caller: null } });
    expect(findOwnedJob(q, anon.id, { vaultId: "main", caller: null })?.id).toBe(anon.id);
    expect(findOwnedJob(q, anon.id, OWNER)).toBeNull();

    const named = q.enqueue("caller_work", { owner: { vaultId: "main", caller: "agent-1" } });
    expect(findOwnedJob(q, named.id, { vaultId: "main", caller: null })).toBeNull();
  });

  it("answers the same for a FOREIGN id as for a MISSING one", () => {
    // Distinguishing them is an oracle: it confirms an id is real, which is enough to enumerate
    // another caller's task ids by probing.
    const q = queue();
    const foreign = q.enqueue("caller_work", { owner: { vaultId: "agents", caller: "x" } });
    expect(findOwnedJob(q, foreign.id, OWNER)).toBeNull();
    expect(findOwnedJob(q, "no-such-id", OWNER)).toBeNull();
  });
});
