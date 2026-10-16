// `tools/list` for a test that only reads names or counts. `Client.listTools()` also compiles an Ajv
// validator for every advertised outputSchema (SDK `cacheToolMetadata`), which for the 160+ flat tools
// is ~90% of the call (about 0.35s of 0.4s on a fast host, several seconds on a loaded runner). A
// test that goes on to `callTool` against a listed output schema must keep using `listTools()`.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

export async function listToolsRaw(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.request(
      { method: "tools/list", ...(cursor ? { params: { cursor } } : {}) },
      ListToolsResultSchema,
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}
