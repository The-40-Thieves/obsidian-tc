// THE-515: pure span-attribute-key constants, split out of otel/tracing.ts so that importing
// the attribute names (as mcp/registry.ts does, for `span.setAttribute` calls) does not drag the
// OTEL SDK (@opentelemetry/exporter-trace-otlp-http, resources, sdk-trace,
// semantic-conventions) into the import graph of every process — including the 16 non-`serve`
// CLI subcommands and the published `index.ts` barrel, where OTEL is default-off and the SDK
// value-imports were pure dead weight.

/** G2.4 per-span attribute keys (the reliquary_tc.* namespace plus rate_limit.hit). */
export const SPAN_ATTR = {
  vaultId: "reliquary_tc.vault_id",
  tool: "reliquary_tc.tool",
  callerHash: "reliquary_tc.caller_hash",
  scopesRequired: "reliquary_tc.scopes_required",
  status: "reliquary_tc.status",
  errorCode: "reliquary_tc.error_code",
  elicitUsed: "reliquary_tc.elicit_used",
  overflowB: "reliquary_tc.overflow_b",
  durationMs: "reliquary_tc.duration_ms",
  rateLimitHit: "rate_limit.hit",
  itemIndex: "reliquary_tc.item_index",
  spansDropped: "reliquary_tc.spans_dropped",
} as const;
