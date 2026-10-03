// A stand-in for `obsidian-tc <vault>` for first-run-smoke.test.ts: speaks MCP over stdio and prints
// the real boot banner, but its behaviour is picked by STUB_MODE so the harness can be watched
// going green AND red without installing anything.
//   good         dense retrieval works: vec=on, reconcile ok, search_semantic ranks sourdough.md first
//   no-embedder  the local embedder is unreachable: vec=off, reconcile degraded, search_semantic errors
//   lexical      a lexical retriever answers search_semantic: hits carry no embedding_model
//   crash        dies at module load, as a bundle missing a dependency does
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const mode = process.env.STUB_MODE ?? "good";
const text = (payload, isError = false) => ({
  content: [
    { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
  ],
  ...(isError ? { isError: true } : {}),
});

if (mode === "crash") {
  process.stderr.write("Error: Cannot find module 'sqlite-vec' imported from /stub/cli.js\n");
  process.exit(1);
}

const dense = mode === "good";
process.stderr.write(
  `obsidian-tc 9.9.9 ready on stdio (vault main; native=${dense ? "on" : "js-fallback"} vec=${dense ? "on" : "off"})\n`,
);

const server = new McpServer({ name: "first-run-stub", version: "0.0.0" });
const hit = { path: "sourdough.md", score: 0.91 };
const handlers = {
  get_index_status: () =>
    text({
      reconcile: dense || mode === "lexical" ? "ok" : "degraded",
      vec_enabled: dense,
      chunks_upserted: null,
    }),
  server_health: () =>
    text({
      index: {
        detail: {
          reconcile_errors: [
            {
              vault: "main",
              error: 'embeddings.provider "local" could not resolve the optional embedder package',
            },
          ],
        },
      },
    }),
  search_semantic: () => {
    if (mode === "no-embedder")
      return text(
        'Error [embedding_provider_error]: embeddings.provider "local" could not resolve the optional embedder package (retryable)',
        true,
      );
    if (mode === "lexical") return text({ vault: "main", mode_used: "text", items: [hit] });
    return text({
      vault: "main",
      mode_used: "semantic",
      items: [{ ...hit, embedding_model: "stub:model" }],
    });
  },
  search_vault: () => text({ vault: "main", mode_used: dense ? "semantic" : "text", items: [hit] }),
};

server.registerTool(
  "call_capability",
  {
    description: "facade",
    inputSchema: { name: z.string(), args: z.record(z.string(), z.unknown()) },
  },
  ({ name }) => (handlers[name] ? handlers[name]() : text(`unknown capability ${name}`, true)),
);

await server.connect(new StdioServerTransport());
