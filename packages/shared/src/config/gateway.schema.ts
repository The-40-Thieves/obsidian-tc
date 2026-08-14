// THE-832: root-level connection config for the inference gateway (W-GATEWAY-CLIENT). Previously
// reachable ONLY via OBSIDIAN_TC_GATEWAY_URL / OBSIDIAN_TC_GATEWAY_TOKEN. A reporter running this
// as a local patch in production hit a real failure mode env-only config cannot avoid: their host
// app rewrites its own MCP server config on restart and drops env keys it did not author, silently
// reverting the gateway URL and leaving every generative seam (extract/synthesize/judge, rerank)
// unavailable with no error. The config file is a channel that rewrite does not touch. Leaf schema
// — imports Zod only.
import { z } from "zod";

export const GatewayConfigSchema = z.object({
  // z.url(), not z.string().url() — the latter is deprecated in Zod 4 (see reranker.schema.ts).
  baseUrl: z
    .url()
    .optional()
    .describe(
      "Inference gateway base URL. Takes precedence over the OBSIDIAN_TC_GATEWAY_URL environment variable when both are set — set this when a host application rewrites its own env block on restart, which would otherwise silently drop the env var and degrade every generative seam with no error. Absent falls through to the env var, then to graceful degradation.",
    ),
  token: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Bearer token (LiteLLM master/virtual key) for the gateway. Secret — never logged, and takes precedence over the OBSIDIAN_TC_GATEWAY_TOKEN environment variable when both are set.",
    ),
});
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
