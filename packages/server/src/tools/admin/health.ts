import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";

export interface HealthInfo {
  status: "ok";
  name: "obsidian-tc";
  version: string;
  vaults: string[];
  uptime_ms: number;
}

export function createHealthTool(opts: { version: string; vaults: string[]; startedAt: number }): ToolDefinition<Record<string, never>, HealthInfo> {
  return {
    name: "server_health",
    description: "Liveness + build info. Round-trips the full transport -> auth -> acl -> audit path.",
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    handler: () => ({
      status: "ok",
      name: "obsidian-tc",
      version: opts.version,
      vaults: opts.vaults,
      uptime_ms: Date.now() - opts.startedAt,
    }),
  };
}
