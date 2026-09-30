// M7 tool registration (THE-233 integration). Registered onto the shared ToolRegistry in
// cli.ts so the knowledge domain lights up on both stdio and HTTP edges.
import type { ToolRegistry } from "../../mcp/registry";
import { buildKnowledgeTools, type M7Deps } from "./knowledge-tools";

export type { M7Deps } from "./knowledge-tools";

export function registerM7Tools(registry: ToolRegistry, deps: M7Deps): void {
  // search_and_read reads notes of the vault its query names, so it resolves that vault's ACL through
  // the registry's own per-vault resolver (the one dispatch uses), as M1's read_resources does.
  for (const tool of buildKnowledgeTools(deps, (id) => registry.aclFor(id)))
    registry.register(tool);
}
