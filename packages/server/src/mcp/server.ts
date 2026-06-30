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
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { VaultRegistry } from "../vault/registry";
import { getPrompt, listPrompts } from "./prompts";
import type { CallerContext, ToolRegistry } from "./registry";
import { listResources, readResource } from "./resources";

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
}

function asStructured(data: unknown): Record<string, unknown> | undefined {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
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

  server.setRequestHandler(ListToolsRequestSchema, () => {
    // Per-caller filtering (THE-250): the caller's resolved scopes + ACL read-only shape the
    // advertised surface, so a caller never sees a tool it could not dispatch. A full grant
    // (stdio / auth-none) leaves the surface unchanged.
    const ctx = opts.context();
    const tools: Tool[] = opts.registry
      .listVisible({ grantedScopes: ctx.grantedScopes, readOnly: ctx.acl?.readOnly })
      .map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: z.toJSONSchema(def.inputSchema, {
          target: "draft-7",
          reused: "inline",
          unrepresentable: "any",
        }) as unknown as Tool["inputSchema"],
      }));
    return { tools };
  });

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
    const result = await opts.registry.dispatch(req.params.name, args, ctx);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(result.error) }],
        isError: true,
      };
    }
    const structuredContent = asStructured(result.data);
    return {
      content: [{ type: "text", text: JSON.stringify(result.data ?? null) }],
      ...(structuredContent ? { structuredContent } : {}),
    };
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
      (): ListResourcesResult => listResources(vaultRegistry, opts.context()),
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
