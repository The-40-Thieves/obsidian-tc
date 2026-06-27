// M7 tool registration (THE-233 integration). Registered onto the shared ToolRegistry in
// cli.ts so the knowledge domain lights up on both stdio and HTTP edges.
import type { ToolRegistry } from "../../mcp/registry";
import { buildKnowledgeTools, type M7Deps } from "./knowledge-tools";

export type { M7Deps } from "./knowledge-tools";

export function registerM7Tools(registry: ToolRegistry, deps: M7Deps): void {
  for (const tool of buildKnowledgeTools(deps)) registry.register(tool);
}
