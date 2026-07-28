import type { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

/**
 * Connect an assembled MCP server to stdio, the trusted local transport.
 * Returns the transport so the caller can close it on shutdown.
 */
export async function connectStdio(server: Server): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}
