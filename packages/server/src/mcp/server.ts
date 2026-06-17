import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
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
    const tools: Tool[] = opts.registry.list().map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: zodToJsonSchema(def.inputSchema, {
        target: "jsonSchema7",
        $refStrategy: "none",
      }) as unknown as Tool["inputSchema"],
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const result = await opts.registry.dispatch(
      req.params.name,
      req.params.arguments ?? {},
      opts.context(),
    );
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
