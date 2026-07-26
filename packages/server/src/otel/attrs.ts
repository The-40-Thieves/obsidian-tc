// THE-515: pure span-attribute-key constants, split out of otel/tracing.ts so that importing
// the attribute names (as mcp/registry.ts does, for `span.setAttribute` calls) does not drag the
// OTEL SDK (@opentelemetry/exporter-trace-otlp-http, resources, sdk-trace-node,
// semantic-conventions) into the import graph of every process — including the 16 non-`serve`
// CLI subcommands and the published `index.ts` barrel, where OTEL is default-off and the SDK
// value-imports were pure dead weight.

/** G2.4 per-span attribute keys (the obsidian_tc.* namespace plus rate_limit.hit). */
export const SPAN_ATTR = {
  vaultId: "obsidian_tc.vault_id",
  tool: "obsidian_tc.tool",
  callerHash: "obsidian_tc.caller_hash",
  scopesRequired: "obsidian_tc.scopes_required",
  status: "obsidian_tc.status",
  errorCode: "obsidian_tc.error_code",
  elicitUsed: "obsidian_tc.elicit_used",
  overflowB: "obsidian_tc.overflow_b",
  durationMs: "obsidian_tc.duration_ms",
  rateLimitHit: "rate_limit.hit",
} as const;
