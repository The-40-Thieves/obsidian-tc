import {
  type CallToolResult,
  type GetPromptResult,
  inputRequired,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  Server,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Tool,
} from "@modelcontextprotocol/server";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
import type { ElicitCodec, ElicitRequestState } from "../elicit-request-state";
import { extractTraceCarrier } from "../otel/propagation";
import type { VaultRegistry } from "../vault/registry";
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
      capabilities: { tools: {}, prompts: {}, ...(opts.vaultRegistry ? { resources: {} } : {}) },
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

  // SEP-2575: `server/discover` REPLACES the initialize/initialized handshake, which the
  // 2026-07-28 revision removed outright, and the spec makes it mandatory.
  //
  // ⚠ THIS HANDLER IS NOT YET REACHABLE, and saying so here is the point — a registered handler
  // that never runs is indistinguishable from conformance from the outside.
  //
  // The SDK routes a request through the wire registry of the era the CONNECTION was classified
  // as, and `server/discover` exists only in the 2026 registry. In our stateless per-request
  // wiring there is no handshake, so `Protocol.getNegotiatedProtocolVersion()` is `undefined` on
  // every request — including one carrying `MCP-Protocol-Version: 2026-07-28` — and the connection
  // falls back to the 2025 registry, which answers `-32601 Method not found` before this handler
  // is consulted. Verified: the same -32601 comes back from the low-level `Server` AND from
  // `McpServer`, under both the Node and WebStandard transports, so it is not a transport bug and
  // not something a different handler shape fixes.
  //
  // Kept, rather than deleted, because it is correct and complete for the moment era classification
  // reaches Protocol; `test/mcp-protocol-eras.test.ts` pins the CURRENT -32601 so that when the
  // wiring is fixed the test fails loudly instead of the gap going unnoticed. Tracked separately.
  //
  // The response is deliberately caller-independent: a client calls this before establishing
  // anything, so it must not depend on scopes or ACL, and it is safely PUBLIC. Capabilities mirror
  // the constructor's rather than being restated — a discover document that disagreed with the
  // server's real capabilities would be worse than none.
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
    // THE-275 domain-verb facade: a domain meta-tool ("notes", "search", ...) carries {action, args};
    // route the named action straight through registry.dispatch so every gate + the target's own
    // schema validation fire unchanged (identical to call_capability, just grouped by domain).
    if (facadeMode === "domain" && isDomainTool(req.params.name)) {
      const action = typeof args.action === "string" ? args.action : "";
      const actionArgs = (args.args ?? {}) as Record<string, unknown>;
      return dispatchToResult(action, actionArgs, ctx, canElicit);
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
      return dispatchToResult(target, targetArgs, ctx, canElicit);
    }
    return dispatchToResult(req.params.name, args, ctx, canElicit);
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
          () => readResource(vaultRegistry, ctx, req.params.uri, opts.registry.maxResponseBytes),
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
