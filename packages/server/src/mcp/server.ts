import {
  type CallToolResult,
  type GetPromptResult,
  inputRequired,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  ResourceNotFoundError,
  Server,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Tool,
} from "@modelcontextprotocol/server";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
import type { ElicitCodec, ElicitRequestState } from "../elicit-request-state";
import { extractTraceCarrier } from "../otel/propagation";
import type { JobQueue } from "../scheduler/job-queue";
import type { VaultRegistry } from "../vault/registry";
import {
  clientRoots,
  clientSupportsSampling,
  emitLog,
  type RequestLog,
  sampleViaClient,
} from "./client-features";
import { extractClientInfo } from "./client-info";
import {
  describeCapability,
  domainTools,
  type FacadeMode,
  findCapability,
  isDomainTool,
  isFacadeTool,
  toJson,
  triadTools,
} from "./facade";
import { getPrompt, listPrompts } from "./prompts";
import type { CallerContext, ToolDefinition, ToolRegistry } from "./registry";
import { takeSerialized } from "./registry";
import { listResources, readResource } from "./resources";
import {
  clientSupportsTasks,
  TASK_CALL_JOB_TYPE,
  TASKS_EXTENSION,
  type TaskCallPayload,
  toCreateTaskResult,
} from "./tasks";

/**
 * The first "modern" revision (SEP-2575: no initialize handshake, protocol version in `_meta`,
 * `server/discover`). The SDK knows it internally as FIRST_MODERN_PROTOCOL_VERSION but does not
 * export it, and does not include it in SUPPORTED_PROTOCOL_VERSIONS — so it is named here.
 */
const MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * SEP-2549 cache hints. The SDK's cacheable set is a CLOSED list — `tools/list`, `prompts/list`,
 * `resources/list`, `resources/templates/list`, `resources/read`, `server/discover` — and no other
 * result ever carries these fields.
 *
 * `cacheScope` is a SECURITY decision here, not a performance one. `public` invites a SHARED cache
 * to reuse one caller's response for another, so it is only ever correct for a response that does
 * not depend on who asked:
 *
 *   * `tools/list` is filtered by `grantedScopes` (registry.listVisible) in BOTH flat and domain
 *     mode — a scope-limited caller sees fewer tools. PRIVATE.
 *   * `resources/list` / `resources/read` are folder-ACL filtered (`readableRel`) and gated on
 *     `read:notes`. PRIVATE.
 *   * `prompts/list` returns the built-in templates with no filtering and no required scope, so it
 *     is identical for every caller. PUBLIC — asserted by test, because if prompts ever become
 *     vault-derived or caller-scoped this becomes a cross-caller leak.
 *
 * TTLs are deliberately short. The tool surface is fixed for a process lifetime, but the vault is
 * not, and a stale `resources/list` is a correctness bug in a client that trusts it.
 */
const CACHE_PRIVATE = { ttlMs: 60_000, cacheScope: "private" } as const;
const CACHE_PUBLIC = { ttlMs: 300_000, cacheScope: "public" } as const;

// tools/list returns at most this many tools per page; the client follows nextCursor for the
// rest. Set well above the current tool surface (~103) so the whole surface fits one page — a
// client that ignores nextCursor still receives every tool. The cursor exists for MCP pagination
// parity (matching resources/list) and does not truncate a real deployment.
const TOOLS_PAGE_SIZE = 1000;

export interface McpServerOptions {
  name: string;
  version: string;
  registry: ToolRegistry;
  /**
   * Vault registry — the resources handlers use it to resolve a vaultId to its root path.
   * Optional so non-resources callers (e.g. roundtrip tests) need not supply it; resources
   * are then disabled (empty list / unavailable), while tools and prompts are unaffected.
   */
  vaultRegistry?: VaultRegistry;
  /**
   * Produces a fresh CallerContext for each tool call. The transport edge owns
   * auth: stdio supplies a trusted local context; HTTP supplies one derived
   * from the verified JWT. The db handle and vaultId are bound here as well.
   *
   * THE-514: an optional per-request AbortSignal (the SDK's `extra.mcpReq.signal`), threaded through so
   * runDispatch can observe cancellation. Every call site below passes it; a factory that ignores
   * the argument (every one before THE-514, and any test double) is unaffected — the parameter is
   * optional and dispatch treats an absent signal as a no-op.
   */
  context: (signal?: AbortSignal) => CallerContext;
  /**
   * tools/list page size. Defaults to TOOLS_PAGE_SIZE (well above the tool surface, so the whole
   * surface fits one page); overridable only so tests can exercise the cursor-paging path.
   */
  toolsPageSize?: number;
  /** Tool-surface facade mode (THE-219). "triad" advertises 3 meta-tools; "flat" the full surface.
   *  Defaults to "flat" when unset so direct callers/tests are unaffected; cli/http pass the config. */
  facadeMode?: FacadeMode;
  /**
   * THE-583: the protocol era this instance is being constructed to serve, as classified by the
   * SDK (`createMcpHandler`'s `McpRequestContext.era`).
   *
   * It must be supplied rather than read off the Server: we are STATELESS, so there is no
   * handshake and `server.getNegotiatedProtocolVersion()` is `undefined` on every call — including
   * a request that plainly carried `MCP-Protocol-Version: 2026-07-28`. An earlier version of this
   * read it there and silently emitted no 2026-era field at all while looking correct.
   *
   * Absent (stdio, direct construction, tests) means legacy, which is the safe default: no
   * 2026-only field goes on the wire toward a client that never asked for that revision.
   */
  era?: "legacy" | "modern";
  /**
   * THE-583: codec for the 2026-07-28 HITL round trip (SEP-2260/2322). When supplied, an
   * `elicit_required` outcome is answered with `inputRequired({ requestState })` — the protocol's
   * own shape — instead of a bare error a generic client cannot act on. Absent (stdio, tests) keeps
   * the 2025 behaviour: the error, and an `elicit_token` argument to satisfy it.
   */
  elicitCodec?: ElicitCodec;
  /**
   * THE-583: durable queue backing TASK-AUGMENTED tool calls.
   *
   * The Tasks extension methods (`tasks/get` / `tasks/cancel`) are served in the transport, in
   * front of the SDK handler, because it rejects unknown methods. Augmentation is different: it
   * rides `tools/call`, which IS a core method, so it belongs here.
   */
  jobQueue?: JobQueue;
}

/**
 * Did the caller advertise form elicitation?
 *
 * The 2026-07-28 revision carries client capabilities in the per-request `_meta` envelope, but the
 * SDK parses and consumes those keys before a handler runs — so this reads the capabilities object
 * the SDK exposes rather than re-parsing the wire. Offering an `inputRequired` naming a capability
 * the client never advertised is a hard -32021 protocol error, so this gate decides whether the
 * round trip is offered at all.
 */
function clientSupportsFormElicitation(caps: unknown): boolean {
  if (caps === null || typeof caps !== "object") return false;
  const elicitation = (caps as Record<string, unknown>).elicitation;
  return elicitation !== null && typeof elicitation === "object" && "form" in elicitation;
}

/**
 * Map a domain error out of `resources/read` onto the code the spec requires.
 *
 * A `resources/read` miss MUST answer `-32602` (Invalid Params) — the 2026-07-28 revision moved it
 * off the old `-32002`, and the SDK never emits `-32002` at all. Our resource path throws the shared
 * domain errors (`note_not_found`, `invalid_input`, `path_invalid`), which the SDK cannot recognise
 * and therefore reports as `-32603` Internal Error: a CLIENT mistake, reported as a server fault,
 * on the one method the spec calls out by name.
 *
 * Only the caller-fault codes are remapped. An ACL denial or a genuine internal failure is not an
 * invalid parameter, and flattening those into `-32602` would tell a client its request was
 * malformed when the request was fine and the answer was "no".
 */
const RESOURCE_CALLER_FAULTS = new Set([
  "note_not_found",
  "invalid_input",
  "path_invalid",
  "path_ambiguous",
]);

function asResourceProtocolError(e: unknown, uri: string): Error {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && RESOURCE_CALLER_FAULTS.has(code)) {
    return new ResourceNotFoundError(
      uri,
      (e as { message?: string }).message ?? `not found: ${uri}`,
    );
  }
  // Anything else is rethrown untouched, so a genuine internal failure keeps reporting as one.
  return e instanceof Error ? e : new Error(String(e));
}

function asStructured(data: unknown): Record<string, unknown> | undefined {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

/** Human-facing label for a snake_case tool name (spec: clients fall back to `name` if absent). */
function titleize(name: string): string {
  return name
    .split("_")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Derive MCP tool annotations from the registry's OWN ground truth, so the client-visible safety
 * contract cannot drift from server-side enforcement. `readOnlyHint` mirrors the exact `mutating`
 * predicate the dispatch read-only kill-switch uses (registry.runDispatch); `destructiveHint`
 * mirrors `def.destructive`; every vault operation is closed-world (no external side effects).
 * Annotations are advisory hints, never a trust boundary — dispatch still authorizes every call.
 */
function toolAnnotations(def: ToolDefinition): NonNullable<Tool["annotations"]> {
  const mutating = def.destructive === true || def.requiredScopes.some(isMutatingScope);
  return {
    readOnlyHint: !mutating,
    destructiveHint: def.destructive === true,
    openWorldHint: false,
  };
}

// THE-463: a tool's advertised MCP projection (name/title/description/schemas/annotations/icons) is
// immutable after registration, so flat-mode tools/list rebuilt an identical object per request per
// tool. Memoize by def identity — the same frozen Tool instance is reused across every request and
// every per-request server (the defs live on the persistent registry, so this survives the
// per-request server churn in transports/http.ts). toJson is already memoized per schema.
const mcpToolMemo = new WeakMap<ToolDefinition, Tool>();

/** @internal exported for the THE-463 memoization test. */
export function toMcpTool(def: ToolDefinition): Tool {
  const cached = mcpToolMemo.get(def);
  if (cached !== undefined) return cached;
  const tool: Tool = {
    name: def.name,
    title: titleize(def.name),
    description: def.description,
    inputSchema: toJson(def.inputSchema),
    ...(def.outputSchema
      ? { outputSchema: toJson(def.outputSchema) as unknown as Tool["outputSchema"] }
      : {}),
    annotations: toolAnnotations(def),
    ...(def.icons ? { icons: def.icons } : {}),
  };
  Object.freeze(tool);
  mcpToolMemo.set(def, tool);
  return tool;
}
/**
 * Assemble a low-level MCP Server bound to a ToolRegistry. ListTools is sourced
 * from the registry; CallTool routes through registry.dispatch so validation,
 * auth, ACL, HITL, the byte governor, and audit stay authoritative. Resources
 * (vault notes) and Prompts (built-in templates) are served alongside tools;
 * resources enforce the same read scope + folder ACL inline, since they do not
 * pass through registry.dispatch. The assembly is transport-agnostic.
 */
export function createMcpServer(opts: McpServerOptions): Server {
  const server = new Server(
    { name: opts.name, version: opts.version },
    // Advertise resources only when a vaultRegistry is present: without it the resource
    // handlers serve an empty list / throw, so declaring the capability would mislead a client
    // that inspects capabilities to enumerate resources or subscribe to change notifications.
    {
      // THE-583: `logging` is advertised because the SDK still implements it and SEP-2577 gave it
      // a >=12-month window — a client mid-migration can still ask for it. roots/sampling are
      // CLIENT capabilities, so they are never declared here; they are consulted per connection.
      capabilities: {
        tools: {},
        prompts: {},
        logging: {},
        ...(opts.vaultRegistry ? { resources: {} } : {}),
        // THE-583: advertise the Tasks extension, but only when there is a queue to back it. The
        // client checks this before it is willing to receive a handle, so advertising it without a
        // substrate would invite a task we cannot create. `extensions` is the SEP-2575 field.
        ...(opts.jobQueue ? { extensions: { [TASKS_EXTENSION]: {} } } : {}),
      },
      // THE-583: serve BOTH protocol eras from one server. The SDK ships a frozen 2025-11-25 wire
      // codec alongside the 2026-07-28 one and picks per connection, but the shipped
      // SUPPORTED_PROTOCOL_VERSIONS list is 2025-era ONLY — an unmodified v2 server answers a
      // 2026-07-28 client with `400 Unsupported protocol version`. Modern is opt-in, and this is
      // the opt-in.
      //
      // It MUST be set here rather than on the transport: Server.connect() overwrites the
      // transport's own supportedProtocolVersions with the server's. Setting it on the transport
      // looks correct, throws nothing, and silently leaves the server legacy-only.
      //
      // Legacy stays first-class, not tolerated: LiteLLM — the gateway in front of this — pins
      // `mcp` 1.28.1, whose ceiling is 2025-11-25. Dropping the old era would take the MCP plane
      // down. Verified with that exact client against this SDK: negotiated 2025-11-25, listed
      // tools, called one.
      supportedProtocolVersions: [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
      // THE-583: the SDK verifies an echoed `requestState` (HMAC + TTL) BEFORE any handler runs,
      // and only then exposes the decoded payload via `ctx.mcpReq.requestState<T>()`. Wiring it
      // here rather than verifying inside the handler means an unauthenticated state never reaches
      // our code at all — the handler cannot forget to check it.
      ...(opts.elicitCodec
        ? { requestState: { verify: (state: string) => opts.elicitCodec?.verify(state) } }
        : {}),
    },
  );

  /**
   * Attach SEP-2549 cache fields only on a MODERN connection.
   *
   * The 2025-11-25 wire schemas are frozen and know nothing about `ttlMs`/`cacheScope`; emitting
   * them toward a legacy client would put fields on the wire that revision never defined. The
   * negotiated version is per-connection, so this is asked per response rather than once at boot.
   */
  const isModern = opts.era === "modern";
  const withCacheHint = <T extends object>(
    result: T,
    hint: { ttlMs: number; cacheScope: string },
  ): T => (isModern ? { ...result, ...hint } : result);

  const facadeMode: FacadeMode = opts.facadeMode ?? "flat";

  // THE-583: the verbosity floor for server->client log notifications.
  //
  // FIXED at `info`, and deliberately not settable. `logging/setLevel` is NOT a routable method in
  // SDK v2 — it is absent from both the 2025 and 2026 wire registries, and a handler registered for
  // it answers -32601 (measured). The SDK owns that method internally when the capability is
  // declared. Registering our own was dead code that read as a feature, so it is gone rather than
  // left in place looking implemented.
  //
  // SEP-2575 made verbosity a PER-REQUEST `_meta` field, so there is no server-side floor to set:
  // the threshold is the client's, carried on the request, and the SDK's `mcpReq.log` applies it.

  // SEP-2575: `server/discover` REPLACES the initialize/initialized handshake, which the
  // 2026-07-28 revision removed outright, and the spec makes it mandatory.
  //
  // SEP-2575: `server/discover` REPLACES the removed initialize/initialized handshake, and the spec
  // makes it mandatory. It IS reachable — an earlier revision of this comment warned that it was
  // not, which was true when hand-wiring a Server + transport (the SDK routes through the wire
  // registry of the era the CONNECTION was classified as, and stateless serving left that
  // undefined). Serving through `createMcpHandler` classifies the era per request, which is what
  // makes it route. Asserted end to end by mcp-protocol-eras.test.ts rather than left to a comment
  // that cannot notice when it stops being true.
  server.setRequestHandler("server/discover", () =>
    withCacheHint(
      {
        supportedVersions: [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: server.getCapabilities(),
        instructions:
          `${opts.name} ${opts.version} — an MCP server over Obsidian vaults. ` +
          `Tools are authorized per call (scopes + folder ACL); resources are vault notes.`,
      },
      CACHE_PUBLIC,
    ),
  );

  server.setRequestHandler("tools/list", (req, extra): ListToolsResult => {
    // THE-219 facade: in triad/domain mode advertise the three meta-tools instead of the full
    // surface. Every registered tool stays callable by name via call_capability, so nothing is
    // hidden; flat mode is the back-compat full-surface behavior.
    if (facadeMode === "triad") return withCacheHint({ tools: triadTools() }, CACHE_PRIVATE);
    if (facadeMode === "domain") {
      const dctx = opts.context(extra.mcpReq.signal);
      const dvisible = opts.registry.listVisible({
        grantedScopes: dctx.grantedScopes,
        readOnly: dctx.acl?.readOnly,
      });
      return { tools: domainTools(dvisible) };
    }
    // Per-caller filtering (THE-250): the caller's resolved scopes + ACL read-only shape the
    // advertised surface, so a caller never sees a tool it could not dispatch. A full grant
    // (stdio / auth-none) leaves the surface unchanged. Filter first, THEN page: the cursor is an
    // opaque offset into this caller's visible list (mirrors resources/list).
    const ctx = opts.context(extra.mcpReq.signal);
    const visible = opts.registry.listVisible({
      grantedScopes: ctx.grantedScopes,
      readOnly: ctx.acl?.readOnly,
    });
    const pageSize = opts.toolsPageSize ?? TOOLS_PAGE_SIZE;
    const start = req.params?.cursor ? Math.max(0, Number.parseInt(req.params.cursor, 10) || 0) : 0;
    const page = visible.slice(start, start + pageSize);
    // THE-463: reuse the memoized per-tool projection (outputSchema + icons stay opt-in inside
    // toMcpTool, so a tool that declares neither still serializes byte-identically to before).
    const tools: Tool[] = page.map(toMcpTool);
    const nextStart = start + page.length;
    return withCacheHint(
      nextStart < visible.length ? { tools, nextCursor: String(nextStart) } : { tools },
      CACHE_PRIVATE,
    );
  });

  const formatData = (data: unknown): CallToolResult => {
    const structuredContent = asStructured(data);
    return {
      // THE-294: dispatch already serialized this exact object for the byte governor.
      content: [{ type: "text", text: takeSerialized(data) ?? JSON.stringify(data ?? null) }],
      ...(structuredContent ? { structuredContent } : {}),
    };
  };
  // A dispatch failure is a Tool Execution Error, not a JSON-RPC protocol error (MCP 2025-11-25 /
  // SEP-1303): return isError:true with a human-readable sentence AND the full error object as
  // structuredContent, so a model can read what went wrong (e.g. the Zod issues) and self-correct
  // rather than seeing an opaque JSON blob.
  const errorToResult = (error: {
    code: string;
    message: string;
    retryable?: boolean;
  }): CallToolResult => ({
    content: [
      {
        type: "text",
        text: `Error [${error.code}]: ${error.message}${error.retryable ? " (retryable)" : ""}`,
      },
    ],
    structuredContent: error as unknown as Record<string, unknown>,
    isError: true,
  });
  const dispatchToResult = async (
    name: string,
    args: Record<string, unknown>,
    ctx: CallerContext,
    /** Whether the caller advertised form elicitation — decided once per request by the handler. */
    canElicit = false,
    /** This request's log sink (`extra.mcpReq.log`); absent for stdio/direct construction. */
    log?: RequestLog,
  ): Promise<CallToolResult> => {
    const result = await opts.registry.dispatch(name, args, ctx);
    if (!result.ok) {
      // THE-583 (SEP-2260/2322): a confirmation requirement is not a failure, it is a round trip.
      // The 2026-07-28 shape answers with `inputRequired` carrying an opaque state the client
      // echoes back on the retry — which a generic MCP client knows how to complete, where the
      // old `elicit_required` error plus a bespoke `elicit_token` argument required client code
      // written against THIS server.
      //
      // Only on the modern era and only when a codec is wired: a 2025-era caller still gets the
      // error it understands. `args_hash` comes from dispatch itself, so the state is bound to the
      // hash the gate will recompute — deriving it here instead would be a second implementation
      // of the same hash, free to drift.
      // Only when the CLIENT declared it can render a form elicitation. The SDK refuses an
      // `inputRequired` naming a capability the client never advertised (-32021), so offering the
      // round trip unconditionally would turn "needs confirmation" into a hard protocol error for
      // every modern client that cannot prompt a human. Those clients get the plain
      // `elicit_required` error and the 2025 token path, which they can still complete out of band.
      if (result.error.code === "elicit_required" && isModern && opts.elicitCodec && canElicit) {
        const argsHash = (result.error as { details?: { args_hash?: string } }).details?.args_hash;
        if (typeof argsHash === "string") {
          return inputRequired({
            requestState: await opts.elicitCodec.mint({
              tool: name,
              argsHash,
              vaultId: ctx.vaultId,
              caller: ctx.caller,
            }),
            inputRequests: {
              confirm: {
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: `Confirm ${name}: this call changes vault content and needs approval.`,
                  requestedSchema: {
                    type: "object",
                    properties: {
                      approve: { type: "boolean", title: "Approve this change" },
                    },
                    required: ["approve"],
                  },
                },
              },
            },
          }) as unknown as CallToolResult;
        }
      }
      return errorToResult(result.error);
    }
    // THE-583: tell the client when the byte governor TRUNCATED its answer. This was previously
    // visible only in `meta` (and in server-side metrics), so a caller could act on a silently
    // shortened result believing it complete — the failure mode the governor exists to bound, moved
    // one layer up. Fire-and-forget: a log line must never fail the call it describes.
    const overflow = result.meta.overflow_bytes;
    if (typeof overflow === "number" && overflow > 0) {
      void emitLog(log, {
        level: "warning",
        logger: "obsidian-tc/governor",
        data: {
          tool: name,
          overflow_bytes: overflow,
          message: "response truncated by byte ceiling",
        },
      });
    }
    return formatData(result.data);
  };

  server.setRequestHandler("tools/call", async (req, extra): Promise<CallToolResult> => {
    // Bridge the HITL elicit token from tool arguments into the caller context,
    // stripping it from the args so it never perturbs args_hash — the token is
    // bound to the hash of the call WITHOUT the token (see elicit.ts / hitl.ts).
    const rawArgs = (req.params.arguments ?? {}) as Record<string, unknown>;
    let args: Record<string, unknown> = rawArgs;
    let ctx = opts.context(extra.mcpReq.signal);
    // SEP-414: lift W3C trace context out of `_meta` so dispatch's SERVER span is parented to the
    // caller's span. Read from `_meta`, NOT from a transport header — this is the one place that
    // works identically over stdio and Streamable HTTP, and it is where the 2026-07-28 spec puts it.
    // Absent for every caller that sends none, in which case the span is a root exactly as before.
    const traceCarrier = extractTraceCarrier(req.params._meta);
    if (traceCarrier !== undefined) ctx = { ...ctx, traceCarrier };
    // THE-627: same `_meta` bag, second reader — which client software is calling. Absent for every
    // caller that sends none, in which case the session row records NULL rather than a placeholder.
    const clientInfo = extractClientInfo(req.params._meta);
    if (clientInfo !== undefined) ctx = { ...ctx, clientInfo };
    // The SDK consumes the SEP-2575 envelope keys before a handler sees `params._meta`, so client
    // capabilities are read from its own accessor rather than re-parsed off the wire.
    const canElicit = clientSupportsFormElicitation(server.getClientCapabilities());
    // SEP-2575: this request's log sink. The SDK suppresses the notification when the request
    // carried no `io.modelcontextprotocol/logLevel`, which is the MUST NOT we would otherwise break.
    const log = (extra.mcpReq as { log?: RequestLog }).log;
    // SEP-2577: bind the deprecated-but-live client features onto the context, so every tool can
    // reach them. Gated on the client having advertised each one — calling either against a client
    // that did not is a protocol error, not a soft failure.
    ctx = {
      ...ctx,
      roots: () => clientRoots(server),
      ...(clientSupportsSampling(server)
        ? { sample: (p: Parameters<typeof sampleViaClient>[1]) => sampleViaClient(server, p) }
        : {}),
    };
    // THE-583: a verified 2026-07-28 request-state, when the client echoed one. The transport has
    // already checked its HMAC and TTL; dispatch still checks that it authorizes this exact call.
    const echoed = (
      extra.mcpReq as { requestState?: <T>() => T | undefined }
    ).requestState?.<ElicitRequestState>();
    if (echoed !== undefined) ctx = { ...ctx, elicitState: echoed };
    if (typeof rawArgs.elicit_token === "string") {
      const { elicit_token, ...rest } = rawArgs;
      args = rest;
      ctx = { ...ctx, elicitToken: elicit_token };
    }
    // THE-583: run as a background TASK when the client asked and the tool opted in.
    //
    // Both conditions matter. A client asks with `params.task`; a tool declares `taskAugmentable`.
    // Silently deferring a tool that returns in milliseconds would cost the caller a poll round
    // trip to learn what one call would have told it, so augmentation is never inferred.
    //
    // The caller's scopes are snapshotted INTO the job. The runner gets exactly these and nothing
    // else, so a task can never do more than the caller could have done synchronously.
    if (opts.jobQueue && clientSupportsTasks(server.getClientCapabilities())) {
      const def = opts.registry.list().find((d) => d.name === req.params.name);
      if (def?.taskAugmentable) {
        const job = opts.jobQueue.enqueue(TASK_CALL_JOB_TYPE, {
          owner: { vaultId: ctx.vaultId, caller: ctx.caller },
          payload: {
            tool: req.params.name,
            args,
            caller: ctx.caller,
            scopes: [...ctx.grantedScopes],
            vaultId: ctx.vaultId,
            vaultBound: ctx.vaultBound === true,
          } satisfies TaskCallPayload,
        });
        // The handle IS the result: `resultType: "task"` is the discriminator the client switches on
        // to tell it apart from an answer, and it polls `tasks/get` from here.
        return toCreateTaskResult(job) as unknown as CallToolResult;
      }
    }
    // THE-275 domain-verb facade: a domain meta-tool ("notes", "search", ...) carries {action, args};
    // route the named action straight through registry.dispatch so every gate + the target's own
    // schema validation fire unchanged (identical to call_capability, just grouped by domain).
    if (facadeMode === "domain" && isDomainTool(req.params.name)) {
      const action = typeof args.action === "string" ? args.action : "";
      const actionArgs = (args.args ?? {}) as Record<string, unknown>;
      return dispatchToResult(action, actionArgs, ctx, canElicit, log);
    }
    // THE-219 facade interception (boundary-only): find/describe are pure metadata over the
    // caller-visible catalog; call_capability routes the named TARGET through registry.dispatch so
    // every gate (scope/ACL/HITL/idempotency/throttle) and the target's own Layer-6 Zod validation
    // fire unchanged. Any other name (incl. a directly-named tool) takes the normal path below.
    if (facadeMode !== "flat" && isFacadeTool(req.params.name)) {
      const visible = opts.registry.listVisible({
        grantedScopes: ctx.grantedScopes,
        readOnly: ctx.acl?.readOnly,
      });
      if (req.params.name === "find_capability") {
        const query = typeof args.query === "string" ? args.query : "";
        const limit = typeof args.limit === "number" ? args.limit : 10;
        return formatData({ matches: findCapability(visible, query, limit) });
      }
      if (req.params.name === "describe_capability") {
        const target = visible.find((d) => d.name === args.name);
        if (!target)
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  code: "not_found",
                  message: `unknown capability: ${String(args.name)}`,
                }),
              },
            ],
            isError: true,
          };
        return formatData(describeCapability(target));
      }
      const target = typeof args.name === "string" ? args.name : "";
      const targetArgs = (args.args ?? {}) as Record<string, unknown>;
      return dispatchToResult(target, targetArgs, ctx, canElicit, log);
    }
    return dispatchToResult(req.params.name, args, ctx, canElicit, log);
  });

  // Resources: vault notes. resources.ts owns AUTHORIZATION (read:notes scope, vault binding,
  // folder read-ACL, path containment) and keeps it - that is the security boundary. THE-415
  // routes both ops through registry.dispatchResource so they also get the GOVERNANCE tools get:
  // the THE-210 rate limiter and an audit row. Before this they had neither, so a read:notes
  // caller could pull the vault in a loop with no budget and leave no audit trail. Registered only when a
  // vaultRegistry is supplied, matching the conditionally-advertised resources capability: the
  // MCP SDK refuses a handler for an undeclared capability, and a client sees resources/* as
  // unsupported rather than as a misleading empty/error surface.
  const { vaultRegistry } = opts;
  if (vaultRegistry) {
    server.setRequestHandler("resources/list", (req, extra): Promise<ListResourcesResult> => {
      const ctx = opts.context(extra.mcpReq.signal);
      return opts.registry
        .dispatchResource(
          "resources/list",
          ctx,
          ["read:notes"],
          { cursor: req.params?.cursor ?? null },
          () => listResources(vaultRegistry, ctx, req.params?.cursor),
        )
        .then((r) => withCacheHint(r, CACHE_PRIVATE));
    });
    server.setRequestHandler("resources/read", (req, extra): Promise<ReadResourceResult> => {
      const ctx = opts.context(extra.mcpReq.signal);
      return opts.registry
        .dispatchResource(
          "resources/read",
          ctx,
          ["read:notes"],
          { uri: req.params.uri },
          // THE-514 item 2: pass the registry's configured maxResponseBytes so a lowered ceiling
          // applies to resources too, not just tools — resources.ts no longer holds its own
          // unconfigurable fixed copy of the default.
          () => {
            // Synchronous, so a try/catch rather than .catch — the miss must surface as -32602.
            try {
              return readResource(
                vaultRegistry,
                ctx,
                req.params.uri,
                opts.registry.maxResponseBytes,
              );
            } catch (e) {
              throw asResourceProtocolError(e, req.params.uri);
            }
          },
        )
        .then((r) => withCacheHint(r, CACHE_PRIVATE));
    });
  }

  // Prompts: built-in, static templates (no vault access, so no authorization gate — like the
  // unauthenticated liveness surface). THE-415 left prompts as the last MCP surface that skipped
  // ToolRegistry governance entirely; route both ops through dispatchResource so they get the same
  // GOVERNANCE resources get — the THE-210 rate limiter and an audit row — making "every invocation
  // is audited" hold for the prompt surface too. dispatchResource applies throttle + audit + metrics
  // but enforces no scope (authorization stays the handler's job), so passing [] preserves the
  // open-template semantics while closing the observability gap.
  server.setRequestHandler("prompts/list", (_req, extra): Promise<ListPromptsResult> => {
    const ctx = opts.context(extra.mcpReq.signal);
    return opts.registry
      .dispatchResource("prompts/list", ctx, [], {}, () => listPrompts())
      .then((r) => withCacheHint(r, CACHE_PUBLIC));
  });
  server.setRequestHandler("prompts/get", (req, extra): Promise<GetPromptResult> => {
    const ctx = opts.context(extra.mcpReq.signal);
    return opts.registry.dispatchResource("prompts/get", ctx, [], { name: req.params.name }, () =>
      getPrompt(req.params.name, req.params.arguments),
    );
  });

  return server;
}
