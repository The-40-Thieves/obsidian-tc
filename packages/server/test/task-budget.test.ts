// A long tool must answer inside a client's time limit (Codex 60 s, ChatGPT ~60 s, Cloudflare Agents
// 60 s) even when the client never declared the Tasks extension. The tool still runs as the queue's
// MCP task, so the machinery is the existing one; what is new is the budget:
//
//   * a client WITH the extension still gets the handle at once (unchanged, task-augmented.test.ts);
//   * a client WITHOUT it waits up to `taskBudgetMs` for the real result, and on expiry gets a
//     handle it can poll with `get_task_status`, instead of holding the request open until the
//     client's own timeout kills it.
//
// No test here is slow: the "long operation" is a handler parked on a promise the test releases, and
// the budget is 40 ms.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { JobQueue } from "../src/scheduler/job-queue";
import { makeStartTask } from "../src/scheduler/task-call-runner";
import { createTaskStatusTool } from "../src/tools/admin/task-status";
import { openMemoryDb } from "./helpers";

const BUDGET_MS = 40;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Rig {
  client: Client;
  queue: JobQueue;
  release: () => void;
  close: () => Promise<void>;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function rig(opts: { caller?: string | null; withQueue?: boolean } = {}): Promise<Rig> {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const queue = new JobQueue(db);
  const gate = deferred();
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
  registry.register(
    tool("slow_op", async () => {
      await gate.promise;
      return { finished: true };
    }),
  );
  registry.register(tool("fast_op", () => ({ finished: true, fast: true })));
  registry.register(
    tool("failing_op", () => {
      throw new Error("kaboom");
    }),
  );
  registry.register(createTaskStatusTool({ queue }));
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
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode: "flat",
    ...(opts.withQueue === false
      ? {}
      : {
          jobQueue: queue,
          startTask: makeStartTask({ registry, db, acl, queue }, "test-runner"),
          taskBudgetMs: BUDGET_MS,
        }),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  // No capabilities at all: this client never declared the Tasks extension.
  const client = new Client({ name: "no-tasks", version: "0" });
  await client.connect(ct);
  const close = async () => {
    gate.resolve();
    await client.close();
    await server.close();
  };
  open.push(close);
  return { client, queue, release: () => gate.resolve(), close };
}

const structured = (r: unknown) =>
  (r as { structuredContent: Record<string, unknown> }).structuredContent;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

async function untilCompleted(client: Client, taskId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const r = await client.callTool({ name: "get_task_status", arguments: { task_id: taskId } });
    const s = structured(r);
    if (s.status !== "working") return s;
    await new Promise((r2) => setTimeout(r2, 10));
  }
  throw new Error("task never left working");
}

describe("a long tool called by a client without Tasks support", () => {
  it("returns a handle inside the budget instead of hanging", async () => {
    const { client } = await rig();
    const t0 = performance.now();
    const res = await client.callTool({ name: "slow_op", arguments: {} });
    const elapsed = performance.now() - t0;
    // The handler is still parked: only the budget can have ended this call.
    expect(elapsed).toBeLessThan(BUDGET_MS + 1500);
    expect(res.isError).not.toBe(true);
    expect(structured(res)).toMatchObject({
      status: "working",
      task_id: expect.any(String),
      poll_tool: "get_task_status",
    });
    // Codex and several other clients read ONLY the text block.
    expect(text(res)).toContain(structured(res).task_id as string);
    expect(text(res)).toContain("get_task_status");
  });

  it("the handle resolves to the real result once the work finishes", async () => {
    const { client, release } = await rig();
    const handle = structured(await client.callTool({ name: "slow_op", arguments: {} }));
    release();
    const done = await untilCompleted(client, handle.task_id as string);
    expect(done.status).toBe("completed");
    expect(done.result).toMatchObject({ finished: true });
  });

  it("a call that finishes inside the budget returns its result, not a handle", async () => {
    const { client } = await rig();
    const res = await client.callTool({ name: "fast_op", arguments: {} });
    expect(structured(res)).toEqual({ finished: true, fast: true });
    expect(res.isError).not.toBe(true);
  });

  it("a call that fails inside the budget returns the failure, not a handle", async () => {
    const { client } = await rig();
    const res = await client.callTool({ name: "failing_op", arguments: {} });
    expect(res.isError).toBe(true);
    // Exactly what a synchronous call says: dispatch hides a thrown message behind "internal error"
    // (it can carry paths and SQL), so the budgeted path must not surface the raw one either.
    const sync = await (await rig({ withQueue: false })).client.callTool({
      name: "failing_op",
      arguments: {},
    });
    expect(text(res)).toBe(text(sync));
    expect(text(res)).not.toContain("kaboom");
  });

  it("a tool that did not opt in is untouched by the budget path", async () => {
    // get_task_status itself is not augmentable: it must answer inline, never as a handle.
    const { client } = await rig();
    const res = await client.callTool({ name: "get_task_status", arguments: { task_id: "nope" } });
    expect(structured(res)?.status).not.toBe("working");
  });

  it("falls back to a plain synchronous call when there is no queue", async () => {
    const { client } = await rig({ withQueue: false });
    const res = await client.callTool({ name: "fast_op", arguments: {} });
    expect(structured(res)).toEqual({ finished: true, fast: true });
  });

  it("falls back to a plain synchronous call for a caller that could never poll the handle", async () => {
    const { client } = await rig({ caller: null });
    const res = await client.callTool({ name: "fast_op", arguments: {} });
    expect(structured(res)).toEqual({ finished: true, fast: true });
  });
});

describe("get_task_status", () => {
  it("does not reveal a task that belongs to someone else", async () => {
    const { client, queue } = await rig();
    const foreign = queue.enqueue("mcp_tool_call", {
      owner: { vaultId: "v1", caller: "somebody-else" },
      payload: {},
    });
    const res = await client.callTool({
      name: "get_task_status",
      arguments: { task_id: foreign.id },
    });
    expect(res.isError).toBe(true);
    // Indistinguishable from an id that does not exist.
    const missing = await client.callTool({
      name: "get_task_status",
      arguments: { task_id: "does-not-exist" },
    });
    expect(text(res)).toBe(text(missing));
  });

  it("does not reveal internal maintenance jobs (no owner)", async () => {
    const { client, queue } = await rig();
    const internal = queue.enqueue("contradiction", { payload: { secret: "/vault/private.md" } });
    const res = await client.callTool({
      name: "get_task_status",
      arguments: { task_id: internal.id },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toContain("private.md");
  });
});
