// THE-583: the MCP Tasks EXTENSION (2026-07-28), backed by the THE-517 durable queue.
//
// Tasks left the core protocol in this revision and was redesigned: the blocking `tasks/result` is
// gone, replaced by polling `tasks/get`, with `tasks/cancel` to stop work and `tasks/list` removed
// outright. The SDK ships no runtime for any of it — every Task symbol it exports is marked
// "2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only" — so
// this is an implementation of the extension, not an adoption of an SDK feature. Extension methods
// DO route through `setRequestHandler` on a modern connection (verified on the wire), which is what
// makes serving it possible at all.
//
// OWNERSHIP IS THE WHOLE SAFETY STORY. The queue holds internal maintenance work — reconcile,
// contradiction, synthesis, audit, index writes — that no MCP caller asked for, and whose `payload`
// and `last_error` carry vault paths and error text. A task is visible here only when the job
// carries the CALLER'S identity and the CALLER'S vault; the `vault_id IS NULL` case (every existing
// row, and every existing enqueue call site) is invisible by construction rather than by a filter
// someone has to remember to write.
import type { Job, JobQueue } from "../scheduler/job-queue";

/**
 * The extension's status vocabulary.
 *
 * Prefixed `Mcp` deliberately: this codebase ALREADY has a `TaskStatus` in `tools/m4/tasks-model.ts`
 * meaning a vault to-do item's state. Two unrelated senses of "task" in one tree is exactly the
 * collision the duplicate-exports gate exists to catch — a reader who finds the wrong one is not
 * warned by anything. `input_required` has no queue equivalent yet — see toMcpTask.
 */
export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  /**
   * TTL from creation in ms, or null for unlimited. REQUIRED and nullable in the extension schema,
   * so it is not optional here. Null is the honest value: the queue's rows are durable and are not
   * reaped on a clock, so a task does not expire out from under a client that stops polling.
   */
  ttlMs: number | null;
  /** Poll hint, in ms. Only meaningful while the task is still working. */
  pollIntervalMs?: number;
  /** Human-readable detail. Carries the failure reason on a failed task, and nothing otherwise. */
  statusMessage?: string;
  /** `CompletedTask.result` — the CallToolResult the synchronous call would have returned. */
  result?: Record<string, unknown>;
  /** `FailedTask.error` — the JSON-RPC error that ended the task. */
  error?: { code: number; message: string };
}

/** How often a client should poll a still-working task. Matches the queue's own lease cadence. */
const POLL_INTERVAL_MS = 2_000;

/**
 * Project a queue job onto the extension's status vocabulary.
 *
 * The two vocabularies do not line up one-to-one, and the gaps are decisions rather than oversights:
 *
 *   * `queued`, `running` and `retrying` all mean WORKING to a client. A retry is not a distinct
 *     outcome to poll on — it is the queue doing its job — and exposing it would leak the retry
 *     policy into a client contract we would then have to keep.
 *   * CANCELLED is not a queue state. The queue records cancellation as a REQUEST flag that the
 *     runner honours at its next checkpoint, so a cancelled task is one that reached a terminal
 *     state with the flag set. Reporting `cancelled` while the job is still running would tell the
 *     client the work has stopped when it has not.
 *   * `input_required` is unreachable today: nothing in the queue can ask its caller a question
 *     mid-run. It is in the type because it is in the spec, and a projection that silently mapped
 *     it onto something else would be worse than one that cannot produce it.
 */
export function toMcpTask(job: Job): McpTask {
  const terminal = job.state === "complete" || job.state === "failed";
  const status: McpTaskStatus = terminal
    ? job.cancelRequested
      ? "cancelled"
      : job.state === "complete"
        ? "completed"
        : "failed"
    : "working";
  return {
    taskId: job.id,
    status,
    createdAt: new Date(job.createdAt).toISOString(),
    lastUpdatedAt: new Date(job.updatedAt).toISOString(),
    ttlMs: null,
    ...(status === "working" ? { pollIntervalMs: POLL_INTERVAL_MS } : {}),
    // Only on failure. A completed task has nothing to explain, and echoing `last_error` on a
    // cancelled task would surface the runner's abort text as though it were a fault.
    ...(status === "failed" && job.lastError ? { statusMessage: job.lastError } : {}),
    // THE-583: the DetailedTask variants. `CompletedTask.result` carries what the original request
    // would have returned synchronously; `FailedTask.error` carries the JSON-RPC error. Deferred
    // retrieval is the point of the extension — a `completed` task with no result is a client that
    // polled to success and still cannot get its answer.
    //
    // Gated on BOTH the status and the tag, so a mismatch (a `failed` row carrying an ok envelope,
    // reachable only if the two writes interleaved oddly) emits neither field rather than the wrong
    // one under the right name.
    ...(status === "completed" && job.outcome?.ok === true ? { result: job.outcome.result } : {}),
    ...(status === "failed" && job.outcome?.ok === false ? { error: job.outcome.error } : {}),
  };
}

/** The caller a task must belong to before it is visible or cancellable. */
export interface McpTaskOwner {
  vaultId: string;
  caller: string | null;
}

/**
 * Look up an owned job by id.
 *
 * Returns `null` both when the id does not exist AND when it exists but belongs to someone else —
 * deliberately indistinguishable. A "this task is not yours" answer is an oracle: it confirms an id
 * is real, which is enough to enumerate another caller's task ids by probing.
 */
export function findOwnedJob(queue: JobQueue, id: string, owner: McpTaskOwner): Job | null {
  const job = queue.get(id);
  if (job === null) return null;
  const owned = job as Job & { vaultId?: string | null; caller?: string | null };
  // NULL ownership means internal maintenance work: never visible, whoever asks.
  if (owned.vaultId == null) return null;
  if (owned.vaultId !== owner.vaultId) return null;
  if ((owned.caller ?? null) !== owner.caller) return null;
  return job;
}

/** The revision the extension is defined against. Tasks does not exist in 2025-11-25. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/** JSON-RPC error codes this surface uses, matching the codes the SDK emits for the same shapes. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/**
 * Answer a Tasks-extension request, or return `undefined` if the body is not one.
 *
 * Lives outside the SDK's request pipeline by necessity: `createMcpHandler` validates the inbound
 * method against the spec registry and answers -32601 for anything unrecognised, extension methods
 * included — a handler registered on the Server for `tasks/get` is never consulted. So the
 * extension is served in FRONT of the handler, and this function is the whole of it.
 *
 * `undefined` means "not mine": the caller delegates to the SDK handler unchanged, so a body that
 * merely looks task-shaped can never shadow a core method.
 */
export async function serveTaskExtension(
  body: unknown,
  queue: JobQueue,
  owner: McpTaskOwner,
): Promise<Record<string, unknown> | undefined> {
  if (body === null || typeof body !== "object") return undefined;
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return undefined;
  if (
    req.method !== "tasks/get" &&
    req.method !== "tasks/cancel" &&
    req.method !== "tasks/update"
  ) {
    return undefined;
  }

  const id = (req.id as string | number | null) ?? null;
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  // `tasks/list` was REMOVED in this revision; anything else under tasks/ is simply not a method we
  // implement, and saying so is better than a generic parse failure.
  const taskId = (req.params as { taskId?: unknown } | undefined)?.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return fail(INVALID_PARAMS, "taskId is required");
  }

  const job = findOwnedJob(queue, taskId, owner);
  // Deliberately the same answer for "does not exist" and "not yours" — see findOwnedJob. A
  // distinct code here would undo the property that function exists to provide.
  if (job === null) return fail(METHOD_NOT_FOUND, "unknown task");

  if (req.method === "tasks/cancel") {
    // A REQUEST the runner honours at its next checkpoint. The extension schema types
    // `CancelTaskResult = Result` — "an empty acknowledgement. Cancellation is cooperative and
    // eventually consistent." Returning the projected task here instead would read as a REPORT of
    // the outcome, which is the one thing cancellation cannot give you: the work may still be
    // running, and may still reach a non-`cancelled` terminal state.
    queue.requestCancel(job.id);
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (req.method === "tasks/update") {
    // Input responses for a task that is waiting on the client. `inputResponses` is REQUIRED by the
    // schema, so its absence is a malformed call rather than an empty update.
    const responses = (req.params as { inputResponses?: unknown } | undefined)?.inputResponses;
    if (responses === null || typeof responses !== "object" || Array.isArray(responses)) {
      return fail(INVALID_PARAMS, "inputResponses is required");
    }
    // Every key is unknown here, and that is a property of this server rather than a stub. Nothing
    // in the queue can ask its caller a question mid-run, so no task ever reaches `input_required`
    // and no `inputRequests` are ever outstanding to be keyed against. The spec's instruction for
    // exactly this case is to ignore responses for unknown or already-satisfied keys and
    // acknowledge — which is what an empty `UpdateTaskResult` is. Answering an error instead would
    // be wrong twice: it is not a client mistake, and it would make a conformant client retry.
    return { jsonrpc: "2.0", id, result: {} };
  }

  return { jsonrpc: "2.0", id, result: toMcpTask(job) };
}

/**
 * A tool call captured for background execution, with the authorization it was made under.
 *
 * The scope set is snapshotted at ENQUEUE time and the runner is given exactly this and nothing
 * else. That is the whole security contract of task-augmentation: a job cannot do more than the
 * caller could have done synchronously, because the only authority it carries is the authority that
 * was in the request. Reconstructing a context from server config instead — or re-reading the
 * caller's current grants at run time — would make a task a privilege-escalation primitive.
 *
 * A consequence worth naming: a grant revoked AFTER enqueue does not stop a running task. That is
 * inherent to deferring work, not specific to this design — the alternative is re-authorizing
 * mid-run, which needs a revocation channel we do not have.
 */
export interface TaskCallPayload {
  tool: string;
  args: Record<string, unknown>;
  caller: string | null;
  /** Exactly the scopes the caller held at enqueue. Serialized because the runner has no request. */
  scopes: string[];
  vaultId: string;
  vaultBound: boolean;
}

/** The job type a task-augmented tool call is enqueued as. */
export const TASK_CALL_JOB_TYPE = "mcp_tool_call";

/** The extension identifier, as it appears in both client and server capabilities. */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/**
 * Did the client declare the Tasks extension?
 *
 * THIS IS THE TRIGGER, and it replaces the `params.task` flag an earlier pass used. Task creation in
 * 2026-07-28 is SERVER-DIRECTED: "the client signals support by including the extension in its
 * per-request capabilities, and the server decides on a per-request basis whether to materialize a
 * task." There is no per-request opt-in field to read — `TaskAugmentedRequestParams.task` is the
 * 2025-11-25 vocabulary, which is exactly why the SDK marks every symbol around it `@deprecated`.
 *
 * The spec is explicit about the direction of this check: "Never return a task to a client that did
 * not declare support." A client that cannot poll `tasks/get` has no way to ever collect the answer,
 * so handing it a handle instead of a result loses the work.
 *
 * Read from the SDK's capability accessor rather than off the wire: it consumes the SEP-2575 `_meta`
 * envelope keys before a handler runs.
 */
export function clientSupportsTasks(caps: unknown): boolean {
  if (caps === null || typeof caps !== "object") return false;
  const extensions = (caps as { extensions?: unknown }).extensions;
  if (extensions === null || typeof extensions !== "object") return false;
  const entry = (extensions as Record<string, unknown>)[TASKS_EXTENSION];
  return entry !== null && typeof entry === "object";
}

/**
 * The `CreateTaskResult` a server returns in lieu of the ordinary result.
 *
 * `CreateTaskResult = Result & Task` (flat) with `resultType` set to "task" — the discriminator a
 * client switches on to tell a handle apart from an answer.
 */
export function toCreateTaskResult(job: Job): Record<string, unknown> {
  return { resultType: "task", ...toMcpTask(job) };
}

/**
 * Did this `subscriptions/listen` ask for task notifications?
 *
 * The extension spec routes these through `subscriptions/listen`, but the SDK's `SubscriptionFilter`
 * is a strict four-key object (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`,
 * `resourceSubscriptions`) and its `ServerEvent` union is closed over the same four. There is no key
 * a client could send through it and no event a server could publish, so the extension's own stream
 * is served HERE, in front of the SDK handler — the same reason and the same seam `tasks/get` uses.
 *
 * The notification key reuses `TASKS_EXTENSION` itself rather than a second exported constant —
 * namespaced by the extension identifier so it cannot collide with a core key the SDK later adds,
 * with no separate name to keep in sync with it.
 */
export function subscribesToTasks(body: unknown): boolean {
  const params = (body as { params?: { notifications?: Record<string, unknown> } } | null)?.params;
  return params?.notifications?.[TASKS_EXTENSION] === true;
}

/**
 * Serve the Tasks extension's `subscriptions/listen` stream.
 *
 * Ack first, then one `notifications/tasks` frame per state change on a task THIS caller owns —
 * the same ownership predicate `tasks/get` uses, applied to the push side. A change feed is the
 * easiest place to undo an isolation guarantee, because nobody re-checks the thing that pushes.
 *
 * Each frame carries the full task state, which is the point: the spec notes it "eliminat[es] the
 * need for an extra `tasks/get` round-trip". Polling stays supported and is still the default.
 */
export function serveTaskSubscription(
  body: unknown,
  queue: JobQueue,
  owner: McpTaskOwner,
  signal: AbortSignal,
): Response {
  const id = (body as { id?: string | number | null } | null)?.id ?? null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(frame)}\n\n`));
        } catch {
          /* the client hung up between the check and the write */
        }
      };
      // Ack first, carrying the subscription id, exactly as the core streams do.
      send({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          notifications: { [TASKS_EXTENSION]: true },
          _meta: { "io.modelcontextprotocol/subscriptionId": id },
        },
      });
      const unsubscribe = queue.onTaskChange((job) => {
        // OWNERSHIP, on every frame. The queue announces every owned job; this stream may only see
        // the ones belonging to the caller who opened it.
        if (job.vaultId !== owner.vaultId) return;
        if ((job.caller ?? null) !== owner.caller) return;
        send({ jsonrpc: "2.0", method: "notifications/tasks", params: toMcpTask(job) });
      });
      const close = () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (signal.aborted) close();
      else signal.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
