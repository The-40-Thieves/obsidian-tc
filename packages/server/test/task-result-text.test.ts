// A finished task's stored outcome is the tool's raw data record, not a CallToolResult. Every reader
// of a stored task (tasks/get, the notifications/tasks payload, get_task_status) goes through the
// one projection, toMcpTask, so that is where the synchronous call's shaping (a self-contained
// text block, see mcp/tool-result.ts) has to happen: a client that reads only text must get the
// answer from a task exactly as it would from the call.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { CallerContext } from "../src/mcp/registry";
import { serveTaskExtension, toMcpTask } from "../src/mcp/tasks";
import { ensureTextContent, toolDataResult } from "../src/mcp/tool-result";
import { type JobOutcome, JobQueue } from "../src/scheduler/job-queue";
import { createTaskStatusTool } from "../src/tools/admin/task-status";
import { openMemoryDb } from "./helpers";

const OWNER = { vaultId: "main", caller: "agent-1" };
const DATA = { indexed: 3, skipped: 1 };

function finished(outcome: JobOutcome | null, state: "complete" | "failed") {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const queue = new JobQueue(db);
  const job = queue.enqueue("mcp_tool_call", { owner: OWNER });
  queue.claimById(job.id, "w");
  if (outcome) queue.recordOutcome(job.id, outcome, "w");
  if (state === "complete") queue.complete(job.id, "w");
  else queue.fail(job.id, "w", new Error("boom"), { terminal: true });
  return { queue, id: job.id, job: queue.get(job.id) as NonNullable<ReturnType<JobQueue["get"]>> };
}

async function viaTasksGet(queue: JobQueue, id: string) {
  const res = await serveTaskExtension(
    { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { taskId: id } },
    queue,
    OWNER,
  );
  return (res as { result: ReturnType<typeof toMcpTask> }).result;
}

function viaGetTaskStatus(queue: JobQueue, id: string) {
  const tool = createTaskStatusTool({ queue });
  const ctx = { caller: OWNER.caller, vaultId: OWNER.vaultId } as unknown as CallerContext;
  return tool.handler({ task_id: id }, ctx) as ReturnType<typeof toStatus>;
}
// Only for the return type of the tool handler.
const toStatus = () => ({}) as { result?: Record<string, unknown>; error?: { message: string } };

const textOf = (r: Record<string, unknown> | undefined): string[] =>
  ((r?.content as Array<{ type: string; text?: string }> | undefined) ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "");

describe("a completed task's result is shaped like the synchronous call's", () => {
  it("tasks/get carries a non-empty text block and the structured payload", async () => {
    const { queue, id } = finished({ ok: true, result: DATA }, "complete");
    const task = await viaTasksGet(queue, id);
    expect(task.status).toBe("completed");
    expect(textOf(task.result)).toEqual([JSON.stringify(DATA)]);
    expect(task.result?.structuredContent).toEqual(DATA);
  });

  it("is byte-identical to what the same data returns synchronously", async () => {
    const { queue, id } = finished({ ok: true, result: DATA }, "complete");
    expect((await viaTasksGet(queue, id)).result).toEqual(ensureTextContent(toolDataResult(DATA)));
  });

  it("an empty record still yields text (a client reading only text is not left blank)", async () => {
    const { queue, id } = finished({ ok: true, result: {} }, "complete");
    const task = await viaTasksGet(queue, id);
    expect(textOf(task.result).join("").trim()).not.toBe("");
  });

  it("the projection itself (notifications/tasks reuse it) carries the text", () => {
    const { job } = finished({ ok: true, result: DATA }, "complete");
    expect(textOf(toMcpTask(job).result)).toEqual([JSON.stringify(DATA)]);
  });

  it("get_task_status carries the same shaped result", async () => {
    const { queue, id } = finished({ ok: true, result: DATA }, "complete");
    const status = await viaGetTaskStatus(queue, id);
    expect(textOf(status.result)).toEqual([JSON.stringify(DATA)]);
    expect(status.result?.structuredContent).toEqual(DATA);
  });

  it("text that is already present passes through unchanged, never doubled", async () => {
    // A payload field that happens to be called `text` stays data; shaping is idempotent.
    const withText = { text: "already here", n: 1 };
    const { queue, id } = finished({ ok: true, result: withText }, "complete");
    const task = await viaTasksGet(queue, id);
    expect(textOf(task.result)).toEqual([JSON.stringify(withText)]);
    expect(ensureTextContent(task.result as never)).toBe(task.result);
  });
});

describe("a failed task's error carries text", () => {
  const stored: JobOutcome = {
    ok: false,
    error: {
      code: -32603,
      message: "not_found: no such note",
      data: { code: "not_found", message: "no such note" },
    },
  };

  it("tasks/get and get_task_status keep the tool's own error text", async () => {
    const { queue, id } = finished(stored, "failed");
    expect((await viaTasksGet(queue, id)).error?.message).toBe("not_found: no such note");
    expect((await viaGetTaskStatus(queue, id)).error?.message).toBe("not_found: no such note");
  });

  it("an error recorded with no message is given one rather than an empty string", async () => {
    const { queue, id } = finished({ ok: false, error: { code: -32603, message: "" } }, "failed");
    const fromGet = (await viaTasksGet(queue, id)).error?.message ?? "";
    const fromStatus = (await viaGetTaskStatus(queue, id)).error?.message ?? "";
    expect(fromGet.trim()).not.toBe("");
    expect(fromStatus).toBe(fromGet);
  });
});
