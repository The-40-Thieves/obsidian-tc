import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  type ListPromptsResult,
  ListResourcesRequestSchema,
  type ListResourcesResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
import type { VaultRegistry } from "../vault/registry";
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
   */
  context: () => CallerContext;
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
    },
  );

  const facadeMode: FacadeMode = opts.facadeMode ?? "flat";

  server.setRequestHandler(ListToolsRequestSchema, (req): ListToolsResult => {
    // THE-219 facade: in triad/domain mode advertise the three meta-tools instead of the full
    // surface. Every registered tool stays callable by name via call_capability, so nothing is
    // hidden; flat mode is the back-compat full-surface behavior.
    if (facadeMode === "triad") return { tools: triadTools() };
    if (facadeMode === "domain") {
      const dctx = opts.context();
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
    const ctx = opts.context();
    const visible = opts.registry.listVisible({
      grantedScopes: ctx.grantedScopes,
      readOnly: ctx.acl?.readOnly,
    });
    const pageSize = opts.toolsPageSize ?? TOOLS_PAGE_SIZE;
    const start = req.params?.cursor ? Math.max(0, Number.parseInt(req.params.cursor, 10) || 0) : 0;
    const page = visible.slice(start, start + pageSize);
    const tools: Tool[] = page.map((def) => ({
      name: def.name,
      title: titleize(def.name),
      description: def.description,
      inputSchema: toJson(def.inputSchema),
      // outputSchema + icons are opt-in per tool (THE-278); omitted entirely when unset so a tool
      // that declares neither serializes byte-identically to before.
      ...(def.outputSchema
        ? { outputSchema: toJson(def.outputSchema) as unknown as Tool["outputSchema"] }
        : {}),
      annotations: toolAnnotations(def),
      ...(def.icons ? { icons: def.icons } : {}),
    }));
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

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    // Bridge the HITL elicit token from tool arguments into the caller context,
    // stripping it from the args so it never perturbs args_hash — the token is
    // bound to the hash of the call WITHOUT the token (see elicit.ts / hitl.ts).
    const rawArgs = (req.params.arguments ?? {}) as Record<string, unknown>;
    let args: Record<string, unknown> = rawArgs;
    let ctx = opts.context();
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

  // Resources: vault notes. They bypass registry.dispatch, so the handlers enforce the read
  // scope + folder ACL + path containment inline (see resources.ts). Registered only when a
  // vaultRegistry is supplied, matching the conditionally-advertised resources capability: the
  // MCP SDK refuses a handler for an undeclared capability, and a client sees resources/* as
  // unsupported rather than as a misleading empty/error surface.
  const { vaultRegistry } = opts;
  if (vaultRegistry) {
    server.setRequestHandler(
      ListResourcesRequestSchema,
      (req): ListResourcesResult =>
        listResources(vaultRegistry, opts.context(), req.params?.cursor),
    );
    server.setRequestHandler(
      ReadResourceRequestSchema,
      (req): ReadResourceResult => readResource(vaultRegistry, opts.context(), req.params.uri),
    );
  }

  // Prompts: built-in, static templates (no vault access).
  server.setRequestHandler(ListPromptsRequestSchema, (): ListPromptsResult => listPrompts());
  server.setRequestHandler(
    GetPromptRequestSchema,
    (req): GetPromptResult => getPrompt(req.params.name, req.params.arguments),
  );

  return server;
}
