// cancel_task: the cancel half of the handle a long tool returns to a client that cannot use the
// Tasks extension (mcp/task-budget.ts); get_task_status is the poll half. `tasks/cancel` only
// exists for clients that declared the extension, so without this tool a handle holder could watch
// a runaway index run but never stop it.
//
// It asks the queue for a cooperative cancel through the SAME owned-cancel helper `tasks/cancel`
// uses (cancelOwnedTask), and answers with the task projected through the SAME function
// get_task_status uses. Ownership is inherited from the helper, not re-implemented: a missing id,
// another caller's id and internal maintenance work all answer "unknown task".
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { isIdentifiedCaller } from "../../mcp/registry/identified-caller";
import { cancelOwnedTask } from "../../mcp/tasks";
import type { JobQueue } from "../../scheduler/job-queue";
import { projectTaskStatus, TaskStatusOutput } from "./task-status";

export function createTaskCancelTool(opts: {
  queue: JobQueue;
}): ToolDefinition<{ task_id: string }, z.infer<typeof TaskStatusOutput>> {
  return {
    name: "cancel_task",
    domain: "admin",
    description:
      "Ask a long-running tool call that returned a task handle to stop (index_vault on a large vault does). Pass the task_id from the handle. Cancellation is cooperative: the task keeps working until it reaches a checkpoint, so the returned status may still be working; call get_task_status to see it end as cancelled. A task that already finished is returned unchanged. Only the caller that started the task can cancel it. Domain: admin.",
    inputSchema: z.object({ task_id: z.string().min(1).max(200) }).strict(),
    outputSchema: TaskStatusOutput,
    requiredScopes: [],
    // Stops the caller's own background work; it deletes nothing. The task row stays, and a
    // cancelled index run is incremental, so the next one picks up where it left off.
    destructive: false,
    // Not a vault write, so no mutating scope; the wire still must not say read-only.
    mutatesState: true,
    idempotent: true,
    handler: (input, ctx) => {
      if (!isIdentifiedCaller(ctx.caller)) {
        throw err.unauthorized("tasks require an identified caller (this token has no `sub`)");
      }
      const job = cancelOwnedTask(opts.queue, input.task_id, {
        vaultId: ctx.vaultId,
        caller: ctx.caller,
      });
      // The same answer for "missing", "not yours" and "internal job": see get_task_status.
      if (job === null) throw err.notFound("unknown task");
      return projectTaskStatus(opts.queue, job);
    },
  };
}
