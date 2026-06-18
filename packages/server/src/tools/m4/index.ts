// M4 plugin-bridge tool registration (G2.1 bridge-era domains: Excalidraw,
// Dataview, Tasks, Templater, QuickAdd, OCR/Text Extractor, Smart Context,
// make.md, Command palette). Registered onto the same shared ToolRegistry as
// M0-M3 (assembled in cli.ts) so M4 lights up on both the stdio and HTTP edges.
// Bridge tools degrade gracefully (plugin_missing / plugin_unreachable) when a
// plugin or the companion is absent; filesystem tools (Smart Context, Tasks
// list/update) need no plugin and always work.
import type { ToolRegistry } from "../../mcp/registry";
import { buildDataviewTools } from "./dataview-tools";
import { buildExcalidrawTools } from "./excalidraw-tools";
import type { M4Deps } from "./shared";

export type { BridgeTimeouts, M4Deps } from "./shared";
export { DEFAULT_BRIDGE_TIMEOUTS } from "./shared";

export function registerM4Tools(registry: ToolRegistry, deps: M4Deps): void {
  for (const tool of buildExcalidrawTools(deps)) registry.register(tool);
  for (const tool of buildDataviewTools(deps)) registry.register(tool);
}
