// M6 tool registration (G2.1 Domains 25 Bulk operations, 27 URI generation, 28
// Server admin). Registered onto the same shared ToolRegistry assembled in cli.ts,
// so M6 lights up on both the stdio and HTTP edges alongside M0-M5. These three
// domains complete the v1.0 tool surface (Domains 1-28); only M7 (harden + ship)
// remains. Bulk tools + get_metrics share the single injected RateLimiter; URI
// generation is a pure builder with no deps.
import type { ToolRegistry } from "../../mcp/registry";
import { buildAdminTools } from "./admin-tools";
import { buildBulkTools } from "./bulk-tools";
import type { M6Deps } from "./shared";
import { buildUriTools } from "./uri-tools";

export type { M6Deps } from "./shared";

export function registerM6Tools(registry: ToolRegistry, deps: M6Deps): void {
  for (const tool of buildBulkTools(deps)) registry.register(tool);
  for (const tool of buildUriTools()) registry.register(tool);
  for (const tool of buildAdminTools(deps)) registry.register(tool);
}
