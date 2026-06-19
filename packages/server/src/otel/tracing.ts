import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
// OTEL tracing (G2.4 §OTEL traces — THE-183). Conditional by construction: when
// observability.otel.endpoint is unset, initOtel registers NO provider and returns no tracer,
// so the dispatch pipeline takes its tracer-less fast path and nothing is exported (the spec's
// "no-op when unconfigured" / production-default-off). When an endpoint is set, a
// NodeTracerProvider batches OTLP/HTTP spans for service "obsidian-tc".
//
// One root span per tool call (name `obsidian_tc.<tool>`, SERVER kind) is created in the
// dispatch wrapper (mcp/registry.ts) with the attribute set below. The verbose child-span
// hierarchy (auth_check/acl_eval/policy_eval/tool_impl/output_serialize) is deferred to v1.x:
// instrumenting it means fracturing dispatch's tightly-coupled inline stages for marginal value
// at laptop scale, so v1.0 emits the attribute-rich root span in both trace_detail modes. This
// is a documented reconciliation, not an omission.
import { type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export const TRACER_NAME = "obsidian-tc";

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

export interface OtelHandle {
  enabled: boolean;
  /** The tool tracer — present only when OTEL is enabled (endpoint configured). */
  tracer?: Tracer;
  shutdown: () => Promise<void>;
}

/**
 * Initialize OTEL tracing from the observability config. Returns a disabled handle (no tracer,
 * no-op shutdown) when otel.endpoint is unset. Otherwise registers a global NodeTracerProvider
 * exporting OTLP/HTTP to the endpoint and returns its tracer plus a shutdown hook.
 */
export function initOtel(obs: ServerConfig["observability"], version: string): OtelHandle {
  const endpoint = obs.otel.endpoint;
  if (!endpoint) return { enabled: false, shutdown: async () => undefined };
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: TRACER_NAME,
      [ATTR_SERVICE_VERSION]: version,
      [ATTR_SERVICE_INSTANCE_ID]: `${process.pid}-${Date.now()}`,
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, headers: obs.otel.headers })),
    ],
  });
  provider.register();
  return {
    enabled: true,
    tracer: trace.getTracer(TRACER_NAME),
    shutdown: () => provider.shutdown(),
  };
}
