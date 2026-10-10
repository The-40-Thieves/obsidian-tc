// cancel_task: the cancel half of the handle a long tool returns to a client without the Tasks
// extension (get_task_status is the poll half). `tasks/cancel` exists only for Tasks clients, so
// without this a handle holder could watch a runaway index run but never stop it.
//
// The tool is owner-checked exactly like get_task_status and requests cancellation through the same
// shared helper `tasks/cancel` uses, so what is pinned here is the tool's contract: a cooperative
// REQUEST, the projected state afterwards, a terminal task left untouched, and one uniform answer
// for a missing, foreign or internal id.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import {
  serveTaskExtension,
  TASK_CALL_JOB_TYPE,
  TASK_CALL_PAYLOAD_VERSION,
  type TaskCallPayload,
} from "../src/mcp/tasks";
import { JobQueue } from "../src/scheduler/job-queue";
import { makeStartTask } from "../src/scheduler/task-call-runner";
import { createTaskCancelTool } from "../src/tools/admin/task-cancel";
import { createTaskStatusTool } from "../src/tools/admin/task-status";
import { openMemoryDb } from "./helpers";

const BUDGET_MS = 40;
const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  if (!cond()) throw new Error("condition never held");
};

const structured = (r: unknown) =>
  (r as { structuredContent: Record<string, unknown> }).structuredContent;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

interface Rig {
  client: Client;
  queue: JobQueue;
  runs: { started: number; aborted: number };
  startTask: ReturnType<typeof makeStartTask>;
  enqueue: (tool: string, caller?: string) => string;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function rig(
  opts: { caller?: string | null; facadeMode?: "flat" | "triad" } = {},
): Promise<Rig> {
  const db = openMemoryDb();
  provisionCacheDb(db);
  // A short lease makes the runner's cancel poll (lease / 3) fire in milliseconds.
  const queue = new JobQueue(db, { leaseMs: 30 });
  const runs = { started: 0, aborted: 0 };
  const registry = new ToolRegistry();
  const tool = (name: string, handler: ToolDefinition["handler"]): ToolDefinition =>
    ({
      name,
      description: `test tool ${name}`,
      inputSchema: z.object({ vault: z.string().optional() }),
      requiredScopes: [],
      taskAugmentable: true,
      handler,
    }) as unknown as ToolDefinition;
  // Parks until its signal fires, like a cooperative long run (index_vault) does.
  registry.register(
    tool(
      "slow_op",
      (_in, ctx) =>
        new Promise((_, reject) => {
          runs.started++;
          ctx.signal?.addEventListener("abort", () => {
            runs.aborted++;
            reject(new Error("aborted"));
          });
        }),
    ),
  );
  registry.register(
    tool("fast_op", () => {
      runs.started++;
      return { finished: true };
    }),
  );
  registry.register(createTaskStatusTool({ queue }));
  registry.register(createTaskCancelTool({ queue }));
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const caller = opts.caller === undefined ? "stdio" : opts.caller;
  const context = (): CallerContext => ({
    caller,
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
    acl,
  });
  const startTask = makeStartTask({ registry, db, acl, queue }, "test-runner");
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode: opts.facadeMode ?? "flat",
    jobQueue: queue,
    startTask,
    taskBudgetMs: BUDGET_MS,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "no-tasks", version: "0" });
  await client.connect(ct);
  open.push(async () => {
    await startTask.drain();
    await client.close();
    await server.close();
  });
  const enqueue = (toolName: string, owner = "stdio"): string => {
    const payload: TaskCallPayload = {
      v: TASK_CALL_PAYLOAD_VERSION,
      tool: toolName,
      args: {},
      caller: owner,
      authenticated: true,
      scopes: ["*"],
      vaultId: "v1",
      vaultBound: false,
    };
    return queue.enqueue(TASK_CALL_JOB_TYPE, {
      owner: { vaultId: "v1", caller: owner },
      maxAttempts: 1,
      payload,
    }).id;
  };
  return { client, queue, runs, startTask, enqueue };
}

const cancel = (client: Client, taskId: string) =>
  client.callTool({ name: "cancel_task", arguments: { task_id: taskId } });
const status = async (client: Client, taskId: string) =>
  structured(await client.callTool({ name: "get_task_status", arguments: { task_id: taskId } }));

describe("cancel_task", () => {
  it("a task cancelled before it started never runs its handler and ends cancelled", async () => {
    const { client, queue, runs, startTask, enqueue } = await rig();
    const id = enqueue("slow_op");
    const res = await cancel(client, id);
    expect(res.isError).not.toBe(true);
    // A request, not a report: nothing has claimed the row yet, so it still projects as working.
    expect(structured(res)).toMatchObject({ task_id: id, status: "working" });
    expect(queue.isCancelRequested(id)).toBe(true);
    startTask(id);
    await until(() => queue.get(id)?.state === "failed");
    expect(runs.started).toBe(0);
    expect(await status(client, id)).toMatchObject({ status: "cancelled" });
  });

  it("cancelling a running task aborts its handler and ends cancelled", async () => {
    const { client, queue, runs } = await rig();
    // The budget (40 ms) runs out while slow_op is parked: the client holds a handle.
    const handle = structured(await client.callTool({ name: "slow_op", arguments: {} }));
    const id = handle.task_id as string;
    expect(handle.status).toBe("working");
    await until(() => runs.started === 1);

    const res = await cancel(client, id);
    expect(res.isError).not.toBe(true);
    expect(queue.isCancelRequested(id)).toBe(true);
    await until(() => runs.aborted === 1);
    await until(() => queue.get(id)?.state === "failed");
    expect(await status(client, id)).toMatchObject({ task_id: id, status: "cancelled" });
  });

  it("a completed task is returned unchanged, with its result, and is not flagged", async () => {
    const { client, queue, startTask, enqueue } = await rig();
    const id = enqueue("fast_op");
    startTask(id);
    await until(() => queue.get(id)?.state === "complete");
    const before = await status(client, id);
    expect(before).toMatchObject({ status: "completed", result: { finished: true } });

    const res = await cancel(client, id);
    expect(res.isError).not.toBe(true);
    expect(structured(res)).toEqual(before);
    expect(queue.isCancelRequested(id)).toBe(false);
  });

  it("a failed task stays failed: a late cancel must not relabel it cancelled", async () => {
    const { client, queue, enqueue } = await rig();
    const id = enqueue("no_such_tool");
    const claimed = queue.claimById(id, "w");
    if (!claimed) throw new Error("no claim");
    queue.fail(id, "w", new Error("boom"), { terminal: true });
    const before = await status(client, id);
    expect(before.status).toBe("failed");

    const res = await cancel(client, id);
    expect(structured(res)).toEqual(before);
    expect(queue.isCancelRequested(id)).toBe(false);
  });

  it("a missing, a foreign and an internal id all answer the same not_found, and change nothing", async () => {
    const { client, queue, enqueue } = await rig();
    const foreign = enqueue("slow_op", "somebody-else");
    const internal = queue.enqueue("contradiction", { payload: { secret: "/vault/private.md" } });
    const missing = await cancel(client, "does-not-exist");
    const theirs = await cancel(client, foreign);
    const hidden = await cancel(client, internal.id);
    for (const r of [missing, theirs, hidden]) {
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("not_found");
    }
    expect(text(theirs)).toBe(text(missing));
    expect(text(hidden)).toBe(text(missing));
    expect(text(hidden)).not.toContain("private.md");
    expect(queue.isCancelRequested(foreign)).toBe(false);
    expect(queue.isCancelRequested(internal.id)).toBe(false);
  });

  it("refuses a caller with no identity, and cancels nothing", async () => {
    const { client, queue, enqueue } = await rig({ caller: null });
    const id = enqueue("slow_op", "stdio");
    const res = await cancel(client, id);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("unauthorized");
    expect(queue.isCancelRequested(id)).toBe(false);
  });

  it("works through call_capability on the triad surface", async () => {
    const { client, queue, runs, startTask, enqueue } = await rig({ facadeMode: "triad" });
    const id = enqueue("slow_op");
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "cancel_task", args: { task_id: id } },
    });
    expect(res.isError).not.toBe(true);
    expect(JSON.stringify(res)).toContain(id);
    expect(queue.isCancelRequested(id)).toBe(true);
    startTask(id);
    await until(() => queue.get(id)?.state === "failed");
    expect(runs.started).toBe(0);

    const missing = await client.callTool({
      name: "call_capability",
      arguments: { name: "cancel_task", args: { task_id: "does-not-exist" } },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("not_found");
  });
});

describe("the handle text", () => {
  it("tells a text-only client it can cancel, without changing the structured handle", async () => {
    const { client } = await rig();
    const res = await client.callTool({ name: "slow_op", arguments: {} });
    const id = structured(res).task_id as string;
    expect(text(res)).toContain("cancel_task");
    expect(text(res)).toContain(id);
    // The structured handle is validated against the tool's output schema: it gains no key.
    expect(Object.keys(structured(res)).sort()).toEqual(
      ["message", "poll_tool", "status", "task_id", "tool"].sort(),
    );
  });
});

describe("cancel_task advertisement", () => {
  it("states all three hints explicitly: it changes server state, deletes nothing, stays closed-world", async () => {
    const { client } = await rig();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "cancel_task");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });
    // get_task_status stays the read-only half of the pair.
    expect(tools.find((t) => t.name === "get_task_status")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("describe_capability and the tag agree with the wire annotation", async () => {
    const { client } = await rig({ facadeMode: "triad" });
    const res = await client.callTool({
      name: "describe_capability",
      arguments: { name: "cancel_task" },
    });
    const body = JSON.stringify(res);
    expect(body).toContain('\\"read_only\\":false');
    expect(body).toContain("writes");
  });
});

describe("tasks/cancel shares the helper: a terminal task is not rewritten", () => {
  it("a failed task is acknowledged but stays failed", async () => {
    const { queue, enqueue } = await rig();
    const id = enqueue("no_such_tool");
    queue.claimById(id, "w");
    queue.fail(id, "w", new Error("boom"), { terminal: true });
    const out = await serveTaskExtension(
      { jsonrpc: "2.0", id: 1, method: "tasks/cancel", params: { taskId: id } },
      queue,
      { vaultId: "v1", caller: "stdio" },
    );
    expect(out).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(queue.isCancelRequested(id)).toBe(false);
  });
});
