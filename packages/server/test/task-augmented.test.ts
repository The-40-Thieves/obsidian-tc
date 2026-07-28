// THE-583: task-augmented tool calls — the piece that PRODUCES caller-owned tasks.
//
// Two properties are worth testing and the second is the one that could be catastrophic.
//
// 1. AUGMENTATION IS NEVER INFERRED. It happens only when the client asks (`params.task`) AND the
//    tool opted in (`taskAugmentable`). Deferring a fast tool costs the caller a poll round trip to
//    learn what one call would have told them.
//
// 2. A TASK CANNOT EXCEED ITS CALLER. The runner has no request, so it is trivially easy to write
//    one that runs as the server — and nothing would look wrong: the tool would succeed, the task
//    would read `completed`, and a caller would have performed an operation they had no scope for.
//    The scope snapshot is the only thing standing between "deferred execution" and "privilege
//    escalation primitive", so it gets tested directly.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import {
  clientSupportsTasks,
  TASKS_EXTENSION,
  type TaskCallPayload,
  toCreateTaskResult,
  toMcpTask,
} from "../src/mcp/tasks";
import { type Job, JobQueue } from "../src/scheduler/job-queue";
import { runTaskCall } from "../src/scheduler/task-call-runner";
import { openMemoryDb } from "./helpers";

describe("clientSupportsTasks — the trigger is the CAPABILITY, not a request flag", () => {
  // This replaced a `params.task` check, and the reason is worth keeping. Task creation in
  // 2026-07-28 is server-directed: "the client signals support by including the extension in its
  // per-request capabilities, and the server decides on a per-request basis whether to materialize
  // a task." `TaskAugmentedRequestParams.task` is 2025-11-25 vocabulary — which is precisely why
  // every SDK symbol around it carries `@deprecated`.
  it("is true when the client declared the extension", () => {
    expect(clientSupportsTasks({ extensions: { [TASKS_EXTENSION]: {} } })).toBe(true);
  });

  it("is FALSE when the client declared no extensions — never hand such a client a handle", () => {
    // The spec's own direction: "Never return a task to a client that did not declare support."
    // A client that cannot poll `tasks/get` has no way to collect the answer, so a handle loses the
    // work outright. This is the case that must fail closed.
    expect(clientSupportsTasks({})).toBe(false);
    expect(clientSupportsTasks({ extensions: {} })).toBe(false);
    expect(clientSupportsTasks(undefined)).toBe(false);
    expect(clientSupportsTasks(null)).toBe(false);
  });

  it("is false when the client declared some OTHER extension", () => {
    expect(clientSupportsTasks({ extensions: { "io.example/other": {} } })).toBe(false);
  });

  it("ignores a `task` request flag entirely — that trigger is gone", () => {
    expect(clientSupportsTasks({ task: {} })).toBe(false);
  });
});

describe("toCreateTaskResult", () => {
  it('carries resultType "task", the discriminator a client switches on', () => {
    // Without it a client cannot tell a handle from an answer, and would treat the task envelope as
    // the tool's own output.
    const job = {
      id: "j1",
      type: "t",
      class: "t",
      state: "queued" as const,
      attempt: 0,
      maxAttempts: 5,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      cancelRequested: false,
      checkpoint: undefined,
      payload: undefined,
      idempotencyKey: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
      vaultId: "main",
      caller: "agent-1",
      outcome: null,
    };
    const r = toCreateTaskResult(job);
    expect(r.resultType).toBe("task");
    expect(r.taskId).toBe("j1");
    expect(r.status).toBe("working");
    expect(r).toHaveProperty("ttlMs");
  });
});

function harness() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry();
  const seen: CallerContext[] = [];
  registry.register({
    name: "needs_write",
    description: "test-only tool requiring a write scope",
    inputSchema: z.object({ vault: z.string() }),
    requiredScopes: ["write:notes"],
    handler: (_args: unknown, ctx: CallerContext) => {
      seen.push(ctx);
      return { ran: true };
    },
  } as any);
  const queue = new JobQueue(db);
  const deps = {
    registry,
    db,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    queue,
  };
  return { deps, seen, queue };
}

const payload = (over: Partial<TaskCallPayload> = {}): TaskCallPayload => ({
  tool: "needs_write",
  args: { vault: "main" },
  caller: "agent-1",
  scopes: ["write:notes"],
  vaultId: "main",
  vaultBound: true,
  ...over,
});

describe("runTaskCall — a task carries exactly its caller's authority", () => {
  it("runs the tool when the snapshotted scopes allow it", async () => {
    const { deps, seen } = harness();
    await expect(runTaskCall("j1", payload(), deps)).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("REFUSES when the snapshot lacks the scope — no server authority is substituted", async () => {
    // The escalation case. A runner that built its context from server config instead would sail
    // through this, the task would read `completed`, and nobody would be told.
    const { deps, seen } = harness();
    await expect(runTaskCall("j1", payload({ scopes: ["read:notes"] }), deps)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("refuses with NO scopes at all", async () => {
    const { deps, seen } = harness();
    await expect(runTaskCall("j1", payload({ scopes: [] }), deps)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("hands the tool exactly the snapshotted scope set, not a superset", async () => {
    const { deps, seen } = harness();
    await runTaskCall("j1", payload({ scopes: ["write:notes"] }), deps);
    expect([...(seen[0]?.grantedScopes ?? [])]).toEqual(["write:notes"]);
  });

  it("carries vault binding forward, so a bound token stays bound", async () => {
    // THE-267: a vault-bound caller must not reach another vault. Dropping this in the runner
    // would silently unbind every deferred call.
    const { deps, seen } = harness();
    await runTaskCall("j1", payload({ vaultBound: true }), deps);
    expect(seen[0]?.vaultBound).toBe(true);
    expect(seen[0]?.vaultId).toBe("main");
  });

  it("preserves the caller identity for audit", async () => {
    const { deps, seen } = harness();
    await runTaskCall("j1", payload({ caller: "agent-7" }), deps);
    expect(seen[0]?.caller).toBe("agent-7");
  });

  it("rejects a malformed payload rather than defaulting any field", async () => {
    // Defaulting here is how a job with no scopes would become a job with the server's.
    const { deps } = harness();
    for (const bad of [null, {}, { tool: "x" }, { tool: "x", vaultId: "main", scopes: "nope" }]) {
      await expect(runTaskCall("j1", bad, deps)).rejects.toThrow(/malformed/);
    }
  });

  it("surfaces the tool's own error text, since the caller no longer holds the response", async () => {
    const { deps } = harness();
    await expect(runTaskCall("j1", payload({ tool: "no_such_tool" }), deps)).rejects.toThrow(
      /no_such_tool|not_found|unknown/i,
    );
  });
});

describe("the augmentable set is deliberate", () => {
  it("marks index_vault, the long-running one", async () => {
    // A flag that never reaches the registry is the "registered is not emitting" shape: the
    // augmentation branch would simply never fire and every task request would run synchronously.
    const { registerM2Tools } = await import("../src/tools/m2");
    const reg = new ToolRegistry();
    registerM2Tools(reg, {} as never);
    const idx = reg.list().find((d) => d.name === "index_vault");
    expect(idx?.taskAugmentable).toBe(true);
  });

  it("leaves fast tools alone — a handle is worse than an answer", async () => {
    // The floor: if everything were augmentable, the opt-in would be decorative.
    const { registerM2Tools } = await import("../src/tools/m2");
    const reg = new ToolRegistry();
    registerM2Tools(reg, {} as never);
    const augmentable = reg
      .list()
      .filter((d) => d.taskAugmentable)
      .map((d) => d.name);
    expect(augmentable).toEqual(["index_vault"]);
  });
});

describe("deferred result retrieval — the point of the extension", () => {
  it("records the tool's result, and a completed task carries it", async () => {
    // Without this the runner discarded the result entirely: a client would poll to `completed` and
    // still have no way to obtain what it asked for. That reads as a working feature right up to
    // the moment someone tries to use the answer.
    const { deps, queue } = harness();
    const job = queue.enqueue("mcp_tool_call", { owner: { vaultId: "main", caller: "agent-1" } });
    await runTaskCall(job.id, payload(), deps);

    const stored = queue.get(job.id);
    expect(stored?.outcome).toEqual({ ok: true, result: { ran: true } });
    // The projection only surfaces it on a COMPLETED task — a working one has no result yet.
    expect(toMcpTask({ ...(stored as Job), state: "complete" }).result).toEqual({ ran: true });
    expect(toMcpTask(stored as Job).result).toBeUndefined();
  });

  it("records a JSON-RPC error on failure, and a failed task carries it", async () => {
    const { deps, queue } = harness();
    const job = queue.enqueue("mcp_tool_call", { owner: { vaultId: "main", caller: "agent-1" } });
    // Recorded BEFORE the throw — after it, this code does not run, and `runJob` turns the throw
    // into the terminal `failed` state a client will poll.
    await expect(runTaskCall(job.id, payload({ scopes: [] }), deps)).rejects.toThrow();

    const stored = queue.get(job.id);
    expect(stored?.outcome?.ok).toBe(false);
    const failed = toMcpTask({ ...(stored as Job), state: "failed" });
    expect(failed.error?.code).toBe(-32603);
    expect(typeof failed.error?.message).toBe("string");
  });

  it("does not surface an outcome under the WRONG status field", async () => {
    // A `failed` row carrying an ok envelope must emit neither field rather than the wrong one
    // under the right name.
    const { deps, queue } = harness();
    const job = queue.enqueue("mcp_tool_call", { owner: { vaultId: "main", caller: "agent-1" } });
    await runTaskCall(job.id, payload(), deps);
    const stored = queue.get(job.id);
    const mismatched = toMcpTask({ ...(stored as Job), state: "failed" });
    expect(mismatched.error).toBeUndefined();
    expect(mismatched.result).toBeUndefined();
  });
});
