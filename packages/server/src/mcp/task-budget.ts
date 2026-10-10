// A long tool, a client that will not wait, and no Tasks support on the client.
//
// The Tasks extension solves this for clients that declared it (the handle comes back at once and
// the client polls `tasks/get`). Almost no shipping client has: Codex and ChatGPT cut a call at
// ~60 s, the Cloudflare Agents SDK at 60 s, Claude Code gives up after 5 minutes without progress.
// So a `taskAugmentable` tool called by one of those still runs as the queue's task, and the
// request WAITS for it, but only up to a budget. Inside the budget the caller gets the real result
// exactly as a synchronous call would have returned it. Past it, the caller gets a handle (the
// task id and the tool that reads it) and the call ends, while the task keeps running.
//
// The wait also forwards the task's progress as `notifications/progress` when the caller sent a
// progressToken, which is what resets a client's own timeout while the budget is being spent.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type ErrorJSON, err } from "@the-40-thieves/obsidian-tc-shared";
import type { Job, JobProgress, JobQueue } from "../scheduler/job-queue";
import { errorToCallToolResult } from "./error-rendering";
import type { CallerContext } from "./registry";
import {
  isIdentifiedCaller,
  TASK_CALL_JOB_TYPE,
  type TaskCallPayload,
  toCreateTaskResult,
} from "./tasks";
import { toolDataResult } from "./tool-result";

/**
 * How long a call waits for its task before answering with a handle. Under every client limit in
 * the compatibility table (the tightest is 60 s) with room for the transport and for the poll that
 * follows; `createMcpServer({ taskBudgetMs })` overrides it (tests, and deployments behind a
 * shorter proxy timeout).
 */
export const DEFAULT_TASK_BUDGET_MS = 40_000;

/** The tool a client polls with. Registered in runtime/tool-wiring.ts (`wireHealthTools`). */
export const TASK_STATUS_TOOL = "get_task_status";

const isTerminal = (job: Job): boolean => job.state === "complete" || job.state === "failed";

/**
 * Wait for `jobId` to reach a terminal state, for at most `budgetMs`.
 *
 * Resolves with the job when it finished, or `null` when the budget ran out first (the task keeps
 * running). If the request is aborted (the client cancelled the call) the task is asked to stop and
 * the wait ends: nobody is left to collect the result.
 */
export function awaitJobWithinBudget(
  queue: JobQueue,
  jobId: string,
  budgetMs: number,
  opts: { onProgress?: (p: JobProgress) => void; signal?: AbortSignal } = {},
): Promise<Job | null> {
  return new Promise((resolve) => {
    const cleanups: Array<() => void> = [];
    const finish = (job: Job | null): void => {
      for (const c of cleanups.splice(0)) c();
      resolve(job);
    };
    cleanups.push(
      queue.onTaskChange((job) => {
        if (job.id === jobId && isTerminal(job)) finish(job);
      }),
    );
    if (opts.onProgress) cleanups.push(queue.onProgress(jobId, opts.onProgress));
    const timer = setTimeout(() => finish(null), budgetMs);
    cleanups.push(() => clearTimeout(timer));
    const { signal } = opts;
    if (signal) {
      const onAbort = (): void => {
        queue.requestCancel(jobId);
        finish(null);
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", onAbort));
      }
    }
    // The job may already be done (a task that finished before the listener existed).
    const now = queue.get(jobId);
    if (now !== null && isTerminal(now)) finish(now);
  });
}

/** What a finished task answers, rendered as the synchronous call's own result. */
export function finishedTaskResult(job: Job): CallToolResult {
  const outcome = job.outcome;
  if (job.state === "complete" && outcome?.ok === true) return toolDataResult(outcome.result);
  if (outcome?.ok === false) {
    const data = outcome.error.data;
    // The runner stored the tool's own ErrorJSON; anything else (a throw before the tool ran) is
    // an internal error carrying the recorded message.
    if (data !== undefined && typeof data.code === "string" && typeof data.message === "string") {
      return errorToCallToolResult(data as unknown as ErrorJSON);
    }
    return errorToCallToolResult(err.internal(outcome.error.message).toJSON());
  }
  return errorToCallToolResult(
    err.internal(job.lastError ?? "the task ended without a result").toJSON(),
  );
}

/**
 * The handle a client gets when the budget ran out. A normal (non-error) result: the call did not
 * fail, it is not finished. The poll instruction is in the TEXT block as well, because Codex and
 * several other clients read nothing else.
 */
export function pendingTaskResult(tool: string, job: Job): CallToolResult {
  const message = `${tool} is still running in the background (task ${job.id}). Call ${TASK_STATUS_TOOL} with {"task_id":"${job.id}"} to check on it; when its status is "completed" it carries the result.`;
  const structuredContent = {
    status: "working",
    task_id: job.id,
    poll_tool: TASK_STATUS_TOOL,
    tool,
    message,
  };
  return { content: [{ type: "text", text: message }], structuredContent };
}

export interface TaskOffload {
  queue: JobQueue;
  /** Starts a queued task now, in this process (the runner's own tick is 15 s and serial). */
  startTask?: ((jobId: string) => void) | undefined;
  /** The wait before a handle is answered; `DEFAULT_TASK_BUDGET_MS` when absent. */
  budgetMs?: number | undefined;
  /** The client declared the Tasks extension AND this server serves `tasks/get` to it. */
  clientPollsTasks: boolean;
}

/**
 * Run a `taskAugmentable` tool call as the queue's task, for `dispatchToResult` (the one choke point
 * direct, facade and domain calls all pass through).
 *
 * A client that polls `tasks/*` gets the handle at once. Any other client waits up to the budget and
 * gets the real result, or a handle for `get_task_status`. Resolves `undefined` when the call cannot
 * be offloaded (no identified caller, or no way to start the task for a client that cannot poll):
 * the caller then dispatches synchronously, exactly as before.
 *
 * The caller's scopes are snapshotted INTO the job; the runner gets those and nothing else, so a
 * task never does more than the caller could have done synchronously.
 */
export async function offloadToTask(
  off: TaskOffload,
  call: { tool: string; args: Record<string, unknown>; ctx: CallerContext },
): Promise<CallToolResult | undefined> {
  const { ctx } = call;
  const { caller } = ctx;
  if (!isIdentifiedCaller(caller)) return undefined; // it could never poll the handle
  if (!off.clientPollsTasks && off.startTask === undefined) return undefined;
  const job = off.queue.enqueue(TASK_CALL_JOB_TYPE, {
    owner: { vaultId: ctx.vaultId, caller },
    // One attempt: re-running a failed multi-minute call is the client's decision, not a silent retry.
    maxAttempts: 1,
    payload: {
      tool: call.tool,
      args: call.args,
      caller,
      scopes: [...ctx.grantedScopes],
      vaultId: ctx.vaultId,
      vaultBound: ctx.vaultBound === true,
      progress: ctx.progress !== undefined,
    } satisfies TaskCallPayload,
  });
  // The handle IS the result for a polling client: `resultType: "task"` is what it switches on.
  if (off.clientPollsTasks) return toCreateTaskResult(job) as unknown as CallToolResult;
  off.startTask?.(job.id);
  const done = await awaitJobWithinBudget(
    off.queue,
    job.id,
    off.budgetMs ?? DEFAULT_TASK_BUDGET_MS,
    {
      ...(ctx.progress ? { onProgress: ctx.progress } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
  );
  if (done !== null) return finishedTaskResult(done);
  const pending = off.queue.get(job.id);
  return pending === null ? finishedTaskResult(job) : pendingTaskResult(call.tool, pending);
}
