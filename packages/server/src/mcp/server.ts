import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CallerContext, ToolRegistry } from "./registry";

export interface McpServerOptions {
  name: string;
  version: string;
  registry: ToolRegistry;
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
 * auth, ACL, HITL, the byte governor, and audit stay authoritative. The
 * assembly is transport-agnostic — bind it with stdio or streamable HTTP.
 */
export function createMcpServer(opts: McpServerOptions): Server {
  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} } },
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

  return server;
}
