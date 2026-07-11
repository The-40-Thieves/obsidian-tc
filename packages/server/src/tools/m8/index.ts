// M8 tool registration (THE-229). Registered onto the shared ToolRegistry in cli.ts so the
// experiential domain lights up on both stdio and HTTP edges; tools degrade to
// available:false when the experiential store handle is not open.
import type { ToolRegistry } from "../../mcp/registry";
import { buildExperientialTools, type M8Deps } from "./experiential-tools";

export type { M8Deps } from "./experiential-tools";

export function registerM8Tools(registry: ToolRegistry, deps: M8Deps): void {
  for (const tool of buildExperientialTools(deps)) registry.register(tool);
}
