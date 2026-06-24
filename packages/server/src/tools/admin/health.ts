import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";

export interface HealthInfo {
  status: "ok";
  name: "obsidian-tc";
  version: string;
  /** Number of configured vaults (always present, non-identifying). */
  vault_count: number;
  /** Vault id list — only for authenticated callers (ids are deployment-internal). */
  vaults?: string[];
  uptime_ms: number;
}

export function createHealthTool(opts: {
  version: string;
  vaults: string[];
  startedAt: number;
}): ToolDefinition<Record<string, never>, HealthInfo> {
  return {
    name: "server_health",
    description:
      "Liveness + build info. Round-trips the full transport -> auth -> acl -> audit path.",
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    // requiredScopes [] keeps this an unauthenticated liveness probe, but the vault-id
    // list is emitted only to authenticated callers (F3): ids are deployment-internal.
    handler: (_input, ctx) => ({
      status: "ok",
      name: "obsidian-tc",
      version: opts.version,
      vault_count: opts.vaults.length,
      ...(ctx.authenticated ? { vaults: opts.vaults } : {}),
      uptime_ms: Date.now() - opts.startedAt,
    }),
  };
}
