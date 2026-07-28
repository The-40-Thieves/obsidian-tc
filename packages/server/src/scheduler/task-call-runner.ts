// THE-583: the job handler that executes a TASK-AUGMENTED tool call.
//
// A client asked for a long-running tool to run as a task; `tools/call` snapshotted the request and
// the caller's authorization into a job and handed back a handle. This is where that job runs.
//
// THE AUTHORITY QUESTION IS THE WHOLE DESIGN. A background runner has no request, so it has no
// caller — which makes it very easy to write one that quietly runs as the server. This one
// reconstructs the caller's context from the payload and NOTHING else: the scope set is exactly
// what was captured at enqueue, `vaultBound` is carried forward so a bound token stays bound, and
// the vault is the one the caller was addressing. A task therefore cannot do anything the caller
// could not have done synchronously.
//
// The db and ACL come from the server rather than the payload, deliberately: they are deployment
// state, not caller state. Serializing an ACL into a job would let a job outlive a policy change
// that was made to stop it.
import type { FolderAcl } from "../acl";
import type { Database } from "../db/types";
import type { CallerContext, ToolRegistry } from "../mcp/registry";
import type { TaskCallPayload } from "../mcp/tasks";

export interface TaskCallDeps {
  registry: ToolRegistry;
  db: Database;
  acl: FolderAcl;
}

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
  payload: unknown,
  deps: TaskCallDeps,
  signal?: AbortSignal,
): Promise<void> {
  if (!isTaskCallPayload(payload)) {
    // Terminal by nature: a payload this runner cannot read will not become readable on a retry.
    throw new Error("malformed task-call payload");
  }

  const ctx: CallerContext = {
    caller: payload.caller,
    authenticated: true,
    // EXACTLY the enqueue-time grant. Not the server's, not a superset, not re-read.
    grantedScopes: new Set(payload.scopes),
    vaultId: payload.vaultId,
    vaultBound: payload.vaultBound,
    db: deps.db,
    acl: deps.acl,
    ...(signal ? { signal } : {}),
  };

  const result = await deps.registry.dispatch(payload.tool, payload.args, ctx);
  if (!result.ok) {
    // Surface the tool's own error text. The task reads `failed` with this as its statusMessage,
    // which is the only channel the caller has — they are not holding the response any more.
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
}

/**
 * The queue handler for task-augmented calls, ready to drop into the runner's handler map.
 *
 * A factory rather than an inline closure at the call site: cli.ts is a boot file at its line cap,
 * and wiring that lives next to the thing it wires is easier to find than wiring buried in a
 * thousand-line startup sequence.
 */
export function makeTaskCallHandler(deps: TaskCallDeps) {
  return async (job: { payload: unknown }, runCtx: { signal: AbortSignal }): Promise<void> =>
    runTaskCall(job.payload, deps, runCtx.signal);
}
