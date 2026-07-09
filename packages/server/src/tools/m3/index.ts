// M3 tool registration (G2.1 structured-format domains: Canvas, Bases, Periodic
// Notes, Attachments, Bookmarks, Workspaces). Registered onto the same shared
// ToolRegistry assembled in cli.ts, so M3 lights up on both the stdio and HTTP
// edges alongside M0/M1/M2. M3 is pure-filesystem: every tool reads/writes vault
// files (including .obsidian/* config) through resolveVaultPath + enforcePathAcl;
// no companion plugin or REST endpoint is required.
import type { BridgeClient } from "../../bridge";
import type { ToolRegistry } from "../../mcp/registry";
import type { VaultRegistry } from "../../vault/registry";
import { buildAttachmentTools } from "./attachment-tools";
import { buildBaseTools } from "./base-tools";
import { buildBookmarkTools } from "./bookmark-tools";
import { buildCanvasTools } from "./canvas-tools";
import { buildKanbanTools } from "./kanban-tools";
import { buildPeriodicTools } from "./periodic-tools";
import { buildTableTools } from "./table-tools";
import { buildWorkspaceTools } from "./workspace-tools";

export interface M3Deps {
  vaultRegistry: VaultRegistry;
  /** THE-207: optional Templater bridge for periodic-note template expansion. When absent,
   *  or the companion/Templater is unavailable, creation degrades to a verbatim template copy. */
  templaterBridge?: (vaultId: string) => { client: BridgeClient; timeoutMs: number };
  /** THE-291: index-on-write hook for periodic-note writes (best-effort, backgrounded). */
  reindex?: (vaultId: string, path: string, content: string) => void;
}

export function registerM3Tools(registry: ToolRegistry, deps: M3Deps): void {
  for (const tool of buildCanvasTools(deps)) registry.register(tool);
  for (const tool of buildKanbanTools(deps)) registry.register(tool);
  for (const tool of buildBaseTools(deps)) registry.register(tool);
  for (const tool of buildPeriodicTools(deps)) registry.register(tool);
  for (const tool of buildTableTools(deps)) registry.register(tool);
  for (const tool of buildAttachmentTools(deps)) registry.register(tool);
  for (const tool of buildBookmarkTools(deps)) registry.register(tool);
  for (const tool of buildWorkspaceTools(deps)) registry.register(tool);
}
