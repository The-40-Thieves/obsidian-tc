// M2 tool registration. Registered onto the same shared ToolRegistry assembled in
// cli.ts, so M2 lights up on both the stdio and HTTP edges alongside M0/M1.
import type { ToolRegistry } from "../../mcp/registry";
import { buildIndexTools } from "./index-tools";
import { buildSearchTools } from "./search-tools";
import type { M2Deps } from "./shared";

export type { M2Deps } from "./shared";

export function registerM2Tools(registry: ToolRegistry, deps: M2Deps): void {
  for (const tool of buildIndexTools(deps)) registry.register(tool);
  for (const tool of buildSearchTools(deps)) registry.register(tool);
}
