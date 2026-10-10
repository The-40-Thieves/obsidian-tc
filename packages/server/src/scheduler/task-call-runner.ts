// THE-583: the job handler that executes a TASK-AUGMENTED tool call.
//
// A client asked for a long-running tool to run as a task; `tools/call` snapshotted the request and
// the caller's authorization into a job and handed back a handle. This is where that job runs.
//
// THE AUTHORITY QUESTION IS THE WHOLE DESIGN. A background runner has no request, so it has no
// caller — which makes it very easy to write one that quietly runs as the server. This one
// reconstructs the caller's context from the payload and NOTHING else (mcp/task-caller-context.ts
// owns which keys cross): the scope set is exactly what was captured at enqueue, `vaultBound` is
// carried forward so a bound token stays bound, the persona's tool mask rides along, and the vault
// is the one the caller was addressing. A task therefore cannot do anything the caller could not
// have done synchronously.
//
// The db and ACL come from the server rather than the payload, deliberately: they are deployment
// state, not caller state. Serializing an ACL into a job would let a job outlive a policy change
// that was made to stop it.
import type { FolderAcl } from "../acl";
import type { Database } from "../db/types";
import type { CallerContext, ToolRegistry } from "../mcp/registry";
import { restoreCaller } from "../mcp/task-caller-context";
import type { TaskCallPayload } from "../mcp/tasks";
import { type JobProgress, type JobQueue, newLeaseToken, runJob } from "./job-queue";

export interface TaskCallDeps {
  registry: ToolRegistry;
  db: Database;
  acl: FolderAcl;
  /** Where the outcome is persisted, so `tasks/get` can hand it back. */
  queue: JobQueue;
}

/** JSON-RPC internal error — a tool that refused is a server-side outcome, not a malformed call. */
const INTERNAL_ERROR = -32603;

/** Is this a payload we can run? Rejects a malformed one rather than defaulting any field. */
function isTaskCallPayload(v: unknown): v is TaskCallPayload {
  if (v === null || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.tool === "string" &&
    typeof p.vaultId === "string" &&
    Array.isArray(p.scopes) &&
    p.scopes.every((s) => typeof s === "string") &&
    p.args !== null &&
    typeof p.args === "object"
  );
}

/**
 * Run one task-augmented tool call.
 *
 * Throws on failure, which is what the queue expects — `runJob` turns a throw into a retry or a
 * terminal failure by its own policy, and the projection surfaces that as a `failed` task carrying
 * the message. Returning normally marks the task `completed`.
 */
export async function runTaskCall(
  jobId: string,
  payload: unknown,
  deps: TaskCallDeps,
  signal: AbortSignal | undefined,
  /** The lease token of THIS attempt: every write about the job presents it (see recordOutcome). */
  leaseOwner: string,
): Promise<void> {
  if (!isTaskCallPayload(payload)) {
    // Terminal by nature: a payload this runner cannot read will not become readable on a retry.
    throw new Error("malformed task-call payload");
  }

  const ctx: CallerContext = restoreCaller(payload, {
    db: deps.db,
    acl: deps.acl,
    signal,
    // Only for a call whose client asked for progress. The queue keeps the latest report and fans
    // it out to whoever is waiting on the job (the budgeted wait in mcp/task-budget.ts).
    ...(payload.progress === true
      ? { progress: (p: JobProgress) => deps.queue.reportProgress(jobId, p) }
      : {}),
  });

  const result = await deps.registry.dispatch(payload.tool, payload.args, ctx);
  if (!result.ok) {
    // Recorded BEFORE the throw. `runJob` turns the throw into the terminal `failed` state, and a
    // client polling that state must find `error` already there — recording afterwards is not an
    // option, because after the throw this function no longer runs.
    recorded(
      deps.queue.recordOutcome(
        jobId,
        {
          ok: false,
          error: {
            code: INTERNAL_ERROR,
            message: `${result.error.code}: ${result.error.message}`,
            // The tool's own structured error, so a caller that waits on the job
            // (mcp/task-budget.ts) renders the same text it would have got from a synchronous call.
            data: { ...result.error },
          },
        },
        leaseOwner,
      ),
    );
    // The throw still matters: it is what drives the queue's retry/terminal policy. Returning
    // normally here would mark a failed call `completed`.
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  // Written before `runJob` calls complete(), so `completed` never precedes its own result.
  recorded(
    deps.queue.recordOutcome(jobId, { ok: true, result: asRecord(result.data) }, leaseOwner),
  );
}

/** A superseded attempt's write is refused by the queue; it must stop here, not go on to report. */
function recorded(landed: boolean): void {
  if (!landed) throw new Error("task attempt superseded: its lease is no longer held");
}

/** A CallToolResult is an object; anything else is wrapped so the stored shape stays uniform. */
function asRecord(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : { value: data };
}

/**
 * The queue handler for task-augmented calls, ready to drop into the runner's handler map.
 *
 * A factory rather than an inline closure at the call site: cli.ts is a boot file at its line cap,
 * and wiring that lives next to the thing it wires is easier to find than wiring buried in a
 * thousand-line startup sequence.
 */
export function makeTaskCallHandler(deps: TaskCallDeps) {
  return async (
    job: { id: string; payload: unknown },
    runCtx: { signal: AbortSignal; leaseOwner: string },
  ): Promise<void> => runTaskCall(job.id, job.payload, deps, runCtx.signal, runCtx.leaseOwner);
}

/** `startTask` as the server calls it, plus the handle shutdown needs. */
export interface StartTask {
  (jobId: string): void;
  /**
   * Abort every run this process started and wait for each to settle. An aborted run is
   * `interrupted` (see runJob): its row stays `running`, the lease lapses, and the next runner
   * recovers it, which is the same fate a crash would have given it. Call it before the stores close.
   */
  drain(): Promise<void>;
}

/**
 * Start ONE queued task call immediately, in this process, concurrently with everything else.
 *
 * What a tools/call that cannot wait for the runner's 15 s tick needs: claim the job it just
 * enqueued and run it through the same handler and the same `runJob` lease/heartbeat/cancel
 * machinery the tick uses, so a task started here is indistinguishable from one the tick ran. It
 * returns at once; the outcome is read off the job row. A job someone else already claimed (the
 * tick won the race) is left to them.
 *
 * The runs are not fire-and-forget: each is tracked, and `drain()` is how shutdown stops and awaits
 * them, because the runner's own drain only knows about the jobs IT claimed.
 */
export function makeStartTask(deps: TaskCallDeps, leaseOwner: string): StartTask {
  const handler = makeTaskCallHandler(deps);
  const inFlight = new Set<Promise<unknown>>();
  const stop = new AbortController();
  const start = (jobId: string): void => {
    if (stop.signal.aborted) return; // shutting down: leave the job to the next runner
    const lease = newLeaseToken(leaseOwner);
    const job = deps.queue.claimById(jobId, lease);
    if (job === null) return;
    // runJob records every outcome on the row; there is nothing to do with its result here.
    const run: Promise<unknown> = runJob(deps.queue, job, lease, handler, {
      signal: stop.signal,
    })
      .catch(() => undefined)
      .finally(() => inFlight.delete(run));
    inFlight.add(run);
  };
  return Object.assign(start, {
    drain: async (): Promise<void> => {
      stop.abort();
      await Promise.all([...inFlight]);
    },
  });
}
