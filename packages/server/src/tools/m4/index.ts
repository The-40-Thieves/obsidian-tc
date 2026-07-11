// M4 plugin-bridge tool registration (G2.1 bridge-era domains: Excalidraw,
// Dataview, Tasks, Templater, QuickAdd, OCR/Text Extractor, Smart Context,
// make.md, Command palette). Registered onto the same shared ToolRegistry as
// M0-M3 (assembled in cli.ts) so M4 lights up on both the stdio and HTTP edges.
// Bridge tools degrade gracefully (plugin_missing / plugin_unreachable) when a
// plugin or the companion is absent; filesystem tools (Smart Context, Tasks
// list/update) need no plugin and always work.
import type { ToolRegistry } from "../../mcp/registry";
import { buildBundleTools } from "./bundle-tools";
import { buildCommandTools } from "./command-tools";
import { buildDailyNotesTools } from "./daily-notes-tools";
import { buildDatacoreTools } from "./datacore-tools";
import { buildDataviewTools } from "./dataview-tools";
import { buildExcalidrawTools } from "./excalidraw-tools";
import { buildMakeMdTools } from "./makemd-tools";
import { buildMetadataMenuTools } from "./metadata-menu-tools";
import { buildOcrTools } from "./ocr-tools";
import { buildOmnisearchTools } from "./omnisearch-tools";
import { buildQuickAddTools } from "./quickadd-tools";
import type { M4Deps } from "./shared";
import { buildTasksTools } from "./tasks-tools";
import { buildTemplaterTools } from "./templater-tools";

export type { BridgeTimeouts, M4Deps } from "./shared";
export { bridgeTimeouts, DEFAULT_BRIDGE_TIMEOUTS, openBridge } from "./shared";

export function registerM4Tools(registry: ToolRegistry, deps: M4Deps): void {
  for (const tool of buildExcalidrawTools(deps)) registry.register(tool);
  for (const tool of buildDataviewTools(deps)) registry.register(tool);
  for (const tool of buildDatacoreTools(deps)) registry.register(tool);
  for (const tool of buildDailyNotesTools(deps)) registry.register(tool);
  for (const tool of buildTasksTools(deps)) registry.register(tool);
  for (const tool of buildTemplaterTools(deps)) registry.register(tool);
  for (const tool of buildQuickAddTools(deps)) registry.register(tool);
  for (const tool of buildOcrTools(deps)) registry.register(tool);
  for (const tool of buildOmnisearchTools(deps)) registry.register(tool);
  for (const tool of buildBundleTools(deps)) registry.register(tool);
  for (const tool of buildMakeMdTools(deps)) registry.register(tool);
  for (const tool of buildMetadataMenuTools(deps)) registry.register(tool);
  for (const tool of buildCommandTools(deps)) registry.register(tool);
}
