import type { Readable, Writable } from "node:stream";
import type { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

/**
 * Connect an assembled MCP server to stdio, the trusted local transport.
 * Returns the transport so the caller can close it on shutdown.
 *
 * SDK 2.3: a `Server` serves one connection at a time and `connect()` rejects with
 * `ALREADY_CONNECTED` on a second call. stdio is one process-lifetime connection, so this is
 * called once per server; `io` exists so a test can drive the real transport over in-memory streams.
 */
export async function connectStdio(
  server: Server,
  io?: { stdin: Readable; stdout: Writable },
): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport(io?.stdin, io?.stdout);
  await server.connect(transport);
  return transport;
}
