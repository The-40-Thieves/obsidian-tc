import {
  type CallToolResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  Server,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Tool,
} from "@modelcontextprotocol/server";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
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
    },
  );

  const facadeMode: FacadeMode = opts.facadeMode ?? "flat";

  server.setRequestHandler("tools/list", (req, extra): ListToolsResult => {
    // THE-219 facade: in triad/domain mode advertise the three meta-tools instead of the full
    // surface. Every registered tool stays callable by name via call_capability, so nothing is
    // hidden; flat mode is the back-compat full-surface behavior.
    if (facadeMode === "triad") return { tools: triadTools() };
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
    return nextStart < visible.length ? { tools, nextCursor: String(nextStart) } : { tools };
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
  ): Promise<CallToolResult> => {
    const result = await opts.registry.dispatch(name, args, ctx);
    if (!result.ok) return errorToResult(result.error);
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
      return dispatchToResult(action, actionArgs, ctx);
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
      return dispatchToResult(target, targetArgs, ctx);
    }
    return dispatchToResult(req.params.name, args, ctx);
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
      return opts.registry.dispatchResource(
        "resources/list",
        ctx,
        ["read:notes"],
        { cursor: req.params?.cursor ?? null },
        () => listResources(vaultRegistry, ctx, req.params?.cursor),
      );
    });
    server.setRequestHandler("resources/read", (req, extra): Promise<ReadResourceResult> => {
      const ctx = opts.context(extra.mcpReq.signal);
      return opts.registry.dispatchResource(
        "resources/read",
        ctx,
        ["read:notes"],
        { uri: req.params.uri },
        // THE-514 item 2: pass the registry's configured maxResponseBytes so a lowered ceiling
        // applies to resources too, not just tools — resources.ts no longer holds its own
        // unconfigurable fixed copy of the default.
        () => readResource(vaultRegistry, ctx, req.params.uri, opts.registry.maxResponseBytes),
      );
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
    return opts.registry.dispatchResource("prompts/list", ctx, [], {}, () => listPrompts());
  });
  server.setRequestHandler("prompts/get", (req, extra): Promise<GetPromptResult> => {
    const ctx = opts.context(extra.mcpReq.signal);
    return opts.registry.dispatchResource("prompts/get", ctx, [], { name: req.params.name }, () =>
      getPrompt(req.params.name, req.params.arguments),
    );
  });

  return server;
}
