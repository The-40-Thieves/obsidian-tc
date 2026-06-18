// M5 tool registration (G2.1 memory/capture-era domains: Capture/inbox queue,
// Memory entities, Workspace memory, plur read-API proxy). Registered onto the same
// shared ToolRegistry assembled in cli.ts, so M5 lights up on both the stdio and HTTP
// edges alongside M0-M4. Capture/memory/workspace are pure-SQLite (+ vault file writes
// for materialization/JSONL/commit, funneled through resolveVaultPath + enforcePathAcl);
// only the plur proxy reaches an external service and it degrades when unconfigured.
import type { ToolRegistry } from "../../mcp/registry";
import { buildCaptureTools } from "./capture-tools";
import { buildMemoryTools } from "./memory-tools";
import { buildPlurTools } from "./plur-tools";
import { buildSessionTools } from "./session-tools";
import type { M5Deps } from "./shared";

export type { M5Deps } from "./shared";
export {
  DEFAULT_MEMORY_FOLDER,
  DEFAULT_TRACE_FOLDER,
  memoryFolderFor,
  traceFolderFor,
} from "./shared";

export function registerM5Tools(registry: ToolRegistry, deps: M5Deps): void {
  for (const tool of buildCaptureTools(deps)) registry.register(tool);
  for (const tool of buildMemoryTools(deps)) registry.register(tool);
  for (const tool of buildSessionTools(deps)) registry.register(tool);
  for (const tool of buildPlurTools(deps)) registry.register(tool);
}
