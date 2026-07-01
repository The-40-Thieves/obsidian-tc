import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";

export interface HealthInfo {
  status: "ok";
  name: "obsidian-tc";
  version: string;
  /** True when the compiled native search module is loaded (accelerated path). Non-identifying. */
  native_loaded: boolean;
  /** True when sqlite-vec loaded on the shared cache.db connection at boot. Non-identifying. */
  vec_enabled: boolean;
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
  nativeLoaded: boolean;
  vecEnabled: boolean;
}): ToolDefinition<Record<string, never>, HealthInfo> {
  return {
    name: "server_health",
    description:
      "Liveness + build info. Round-trips the full transport -> auth -> acl -> audit path.",
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    // requiredScopes [] keeps this an unauthenticated liveness probe, but the vault-id list is
    // emitted only to authenticated callers (F3): ids are deployment-internal. The native/vec
    // capability flags are non-identifying, so they stay in the always-present payload.
    handler: (_input, ctx) => ({
      status: "ok",
      name: "obsidian-tc",
      version: opts.version,
      native_loaded: opts.nativeLoaded,
      vec_enabled: opts.vecEnabled,
      vault_count: opts.vaults.length,
      ...(ctx.authenticated ? { vaults: opts.vaults } : {}),
      uptime_ms: Date.now() - opts.startedAt,
    }),
  };
}
