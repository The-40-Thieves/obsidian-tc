// M2 tool registration. Registered onto the same shared ToolRegistry assembled in
// cli.ts, so M2 lights up on both the stdio and HTTP edges alongside M0/M1.
import type { ToolRegistry } from "../../mcp/registry";
import { buildIndexTools } from "./index-tools";
import { buildSearchFetchTools } from "./search-fetch-tools";
import { buildSearchTools } from "./search-tools";
import type { M2Deps } from "./shared";

export type { M2Deps } from "./shared";

export function registerM2Tools(registry: ToolRegistry, deps: M2Deps): void {
  for (const tool of buildIndexTools(deps)) registry.register(tool);
  const searchTools = buildSearchTools(deps);
  for (const tool of searchTools) registry.register(tool);
  // `search` reshapes search_vault's hits (it is not a second search path), so it takes that definition.
  const searchVault = searchTools.find((t) => t.name === "search_vault");
  if (!searchVault) throw new Error("search_vault is not registered; search needs it");
  for (const tool of buildSearchFetchTools(deps, searchVault)) registry.register(tool);
}
