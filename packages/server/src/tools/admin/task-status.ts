// get_task_status: the poll half of the "handle" a long tool returns to a client that cannot use the
// Tasks extension (mcp/task-budget.ts). Clients with the extension poll `tasks/get` instead and
// never need it; both read the SAME owned queue row through the SAME projection (toMcpTask), so the
// two cannot disagree about what a task is.
//
// Ownership is the whole safety story and is inherited, not re-implemented: findOwnedJob answers
// "unknown task" for a missing id, another caller's id AND internal maintenance work alike, so this
// tool is no oracle for which ids exist.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { findOwnedJob, isIdentifiedCaller, toMcpTask } from "../../mcp/tasks";
import type { JobQueue } from "../../scheduler/job-queue";

const TaskStatusOutput = z.object({
  task_id: z.string(),
  status: z.enum(["working", "input_required", "completed", "failed", "cancelled"]),
  created_at: z.string(),
  last_updated_at: z.string(),
  /** Latest report while the task is working: units done / total (total absent when unknown). */
  progress: z
    .object({ done: z.number(), total: z.number().optional(), message: z.string().optional() })
    .optional(),
  /** Seconds to wait before polling again; present only while working. */
  retry_after_seconds: z.number().optional(),
  /** The finished tool's own result, exactly what the synchronous call would have returned. */
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  status_message: z.string().optional(),
});

export function createTaskStatusTool(opts: {
  queue: JobQueue;
}): ToolDefinition<{ task_id: string }, z.infer<typeof TaskStatusOutput>> {
  return {
    name: "get_task_status",
    domain: "admin",
    description:
      "Status of a long-running tool call that returned a task handle instead of a result (index_vault on a large vault does). Pass the task_id from the handle; while status is working it reports progress, and once completed it carries the tool's result. Read-only; only the caller that started the task can read it. Domain: admin.",
    inputSchema: z.object({ task_id: z.string().min(1).max(200) }).strict(),
    outputSchema: TaskStatusOutput,
    requiredScopes: [],
    handler: (input, ctx) => {
      if (!isIdentifiedCaller(ctx.caller)) {
        throw err.unauthorized("tasks require an identified caller (this token has no `sub`)");
      }
      const job = findOwnedJob(opts.queue, input.task_id, {
        vaultId: ctx.vaultId,
        caller: ctx.caller,
      });
      // The same answer for "missing", "not yours" and "internal job": see the header.
      if (job === null) throw err.notFound("unknown task");
      const task = toMcpTask(job);
      const p = task.status === "working" ? opts.queue.progressOf(job.id) : undefined;
      return {
        task_id: task.taskId,
        status: task.status,
        created_at: task.createdAt,
        last_updated_at: task.lastUpdatedAt,
        ...(p ? { progress: { done: p.progress, total: p.total, message: p.message } } : {}),
        ...(task.pollIntervalMs !== undefined
          ? { retry_after_seconds: Math.ceil(task.pollIntervalMs / 1000) }
          : {}),
        ...(task.result !== undefined ? { result: task.result } : {}),
        ...(task.error !== undefined ? { error: task.error } : {}),
        ...(task.statusMessage !== undefined ? { status_message: task.statusMessage } : {}),
      };
    },
  };
}
