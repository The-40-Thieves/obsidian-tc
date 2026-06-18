// M3 tool registration (G2.1 structured-format domains: Canvas, Bases, Periodic
// Notes, Attachments, Bookmarks, Workspaces). Registered onto the same shared
// ToolRegistry assembled in cli.ts, so M3 lights up on both the stdio and HTTP
// edges alongside M0/M1/M2. M3 is pure-filesystem: every tool reads/writes vault
// files (including .obsidian/* config) through resolveVaultPath + enforcePathAcl;
// no companion plugin or REST endpoint is required.
import type { ToolRegistry } from "../../mcp/registry";
import type { VaultRegistry } from "../../vault/registry";
import { buildBaseTools } from "./base-tools";
import { buildCanvasTools } from "./canvas-tools";

export interface M3Deps {
  vaultRegistry: VaultRegistry;
}

export function registerM3Tools(registry: ToolRegistry, deps: M3Deps): void {
  for (const tool of buildCanvasTools(deps)) registry.register(tool);
  for (const tool of buildBaseTools(deps)) registry.register(tool);
}
