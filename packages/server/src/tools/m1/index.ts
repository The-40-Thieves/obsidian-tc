// M1 tool registration. A single registry is assembled in cli.ts and shared by
// both the stdio and HTTP edges, so registering here lights up M1 on both
// transports. Domains are appended as they land.
import type { ToolRegistry } from "../../mcp/registry";
import type { VaultRegistry } from "../../vault/registry";
import { buildFrontmatterTools } from "./frontmatter-tools";
import { buildLinksTools } from "./links-tools";
import { buildNotesTools } from "./notes-tools";
import { buildRegistryTools } from "./registry-tools";
import { buildTagsTools } from "./tags-tools";

export interface M1Deps {
  vaultRegistry: VaultRegistry;
  version: string;
  startedAt: number;
  embeddings: { provider: string; model: string };
  configPath?: string;
  /** Index-on-write (THE-255): a note mutation reindexes its path; a delete drops its chunks.
   *  Optional — omitted in tests, so M1 writes never touch the search index there. */
  reindex?: (vaultId: string, path: string, content: string) => void;
  deindex?: (vaultId: string, path: string) => void;
  /** THE-291 (3B): metadata-index readiness. ready() flips when the boot reconcile's notes pass
   *  committed (independent of embedding success). Absent (tests) -> disk scans. */
  metadataIndex?: { hasFts: boolean; ready: () => boolean };
}

export function registerM1Tools(registry: ToolRegistry, deps: M1Deps): void {
  for (const tool of buildRegistryTools(deps)) registry.register(tool);
  for (const tool of buildNotesTools(deps)) registry.register(tool);
  for (const tool of buildFrontmatterTools(deps)) registry.register(tool);
  for (const tool of buildTagsTools(deps)) registry.register(tool);
  for (const tool of buildLinksTools(deps)) registry.register(tool);
}
