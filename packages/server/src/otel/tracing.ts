// OTEL tracing (G2.4 §OTEL traces — THE-183). Conditional by construction: when
// observability.otel.endpoint is unset, initOtel registers NO provider and returns no tracer,
// so the dispatch pipeline takes its tracer-less fast path and nothing is exported (the spec's
// "no-op when unconfigured" / production-default-off). When an endpoint is set, a
// TracerProvider batches OTLP/HTTP spans for service "obsidian-tc".
//
// One root span per tool call (name `obsidian_tc.<tool>`, SERVER kind) is created in the
// dispatch wrapper (mcp/registry.ts) with the attribute set below. The child-span hierarchy
// (input_parse/auth_check/policy_eval/acl_eval/tool_impl/output_serialize, plus verbose batch-item
// and db spans) is opt-in via observability.otel.detail and lives in ./dispatch-spans.ts; at the
// default "root" nothing beyond the root span is created.
import { type Tracer, trace } from "@opentelemetry/api";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";

// THE-515: SPAN_ATTR (the attribute-key constants) moved to ./attrs, a leaf module with no SDK
// imports — mcp/registry.ts needs the keys but must not drag in the OTEL SDK to get them.

export const TRACER_NAME = "obsidian-tc";

export interface OtelHandle {
  enabled: boolean;
  /** The tool tracer — present only when OTEL is enabled (endpoint configured). */
  tracer?: Tracer;
  shutdown: () => Promise<void>;
}

/**
 * Initialize OTEL tracing from the observability config. Returns a disabled handle (no tracer,
 * no-op shutdown) when otel.endpoint is unset. Otherwise registers a global TracerProvider
 * exporting OTLP/HTTP to the endpoint and returns its tracer plus a shutdown hook.
 *
 * THE-515: async so the four OTEL SDK packages (exporter-trace-otlp-http, resources,
 * sdk-trace, semantic-conventions) load only when an endpoint is actually configured,
 * instead of being value-imported — and paid for by every process, `serve` or not — at module
 * scope. `cli.ts` is this function's only caller and is already async.
 */
export async function initOtel(
  obs: ServerConfig["observability"],
  version: string,
): Promise<OtelHandle> {
  const endpoint = obs.otel.endpoint;
  if (!endpoint) return { enabled: false, shutdown: async () => undefined };
  const [
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { BatchSpanProcessor, TracerProvider },
    { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    { registerTracerProvider },
  ] = await Promise.all([
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-trace"),
    import("@opentelemetry/semantic-conventions"),
    import("./register-provider"),
  ]);
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: TRACER_NAME,
      [ATTR_SERVICE_VERSION]: version,
      [ATTR_SERVICE_INSTANCE_ID]: `${process.pid}-${Date.now()}`,
    }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({ url: endpoint, headers: obs.otel.headers }),
      }),
    ],
  });
  registerTracerProvider(provider);
  return {
    enabled: true,
    tracer: trace.getTracer(TRACER_NAME),
    shutdown: () => provider.shutdown(),
  };
}
