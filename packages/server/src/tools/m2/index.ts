// M2 tool registration. Registered onto the same shared ToolRegistry assembled in
// cli.ts, so M2 lights up on both the stdio and HTTP edges alongside M0/M1.
import type { EmbeddingProvider } from "../../embeddings";
import type { ToolRegistry } from "../../mcp/registry";
import type { VaultRegistry } from "../../vault/registry";
import { buildIndexTools } from "./index-tools";

export interface M2Deps {
  vaultRegistry: VaultRegistry;
  embeddingProvider: EmbeddingProvider;
}

export function registerM2Tools(registry: ToolRegistry, deps: M2Deps): void {
  for (const tool of buildIndexTools(deps)) registry.register(tool);
}
