// M1 tool registration. A single registry is assembled in cli.ts and shared by
// both the stdio and HTTP edges, so registering here lights up M1 on both
// transports. Domains are appended as they land.
import type { ToolRegistry } from "../../mcp/registry";
import { buildFrontmatterTools } from "./frontmatter-tools";
import { buildGraphAnalyticsTools } from "./graph-analytics-tools";
import { buildGraphHealthTools } from "./graph-health-tools";
import { buildLinksTools } from "./links-tools";
import { buildNotesTools } from "./notes-tools";
import { buildRegistryTools } from "./registry-tools";
import type { M1Deps } from "./shared";
import { buildSnapshotTools } from "./snapshot-tools";
import { buildTagsTools } from "./tags-tools";

export type { M1Deps } from "./shared";

export function registerM1Tools(registry: ToolRegistry, deps: M1Deps): void {
  for (const tool of buildRegistryTools(deps)) registry.register(tool);
  for (const tool of buildNotesTools(deps)) registry.register(tool);
  for (const tool of buildFrontmatterTools(deps)) registry.register(tool);
  for (const tool of buildTagsTools(deps)) registry.register(tool);
  for (const tool of buildLinksTools(deps)) registry.register(tool);
  // THE-452: graph analytics over the persisted vault_edges graph (read-only, never ranking).
  for (const tool of buildGraphAnalyticsTools()) registry.register(tool);
  for (const tool of buildGraphHealthTools(deps)) registry.register(tool);
  for (const tool of buildSnapshotTools(deps)) registry.register(tool);
}
