// M1 tool registration. A single registry is assembled in cli.ts and shared by
// both the stdio and HTTP edges, so registering here lights up M1 on both
// transports. Domains are appended as they land.
import type { ToolRegistry } from "../../mcp/registry";
import type { VaultRegistry } from "../../vault/registry";
import { buildFrontmatterTools } from "./frontmatter-tools";
import { buildNotesTools } from "./notes-tools";
import { buildRegistryTools } from "./registry-tools";
import { buildTagsTools } from "./tags-tools";

export interface M1Deps {
  vaultRegistry: VaultRegistry;
  version: string;
  startedAt: number;
  embeddings: { provider: string; model: string };
  configPath?: string;
}

export function registerM1Tools(registry: ToolRegistry, deps: M1Deps): void {
  for (const tool of buildRegistryTools(deps)) registry.register(tool);
  for (const tool of buildNotesTools(deps)) registry.register(tool);
  for (const tool of buildFrontmatterTools(deps)) registry.register(tool);
  for (const tool of buildTagsTools(deps)) registry.register(tool);
}
