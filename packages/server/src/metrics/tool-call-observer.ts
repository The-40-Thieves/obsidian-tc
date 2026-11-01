/** Terminal call status for `obsidian_tc_tool_calls_total` (matches the OTEL status attribute). */
export type ToolCallStatus = "ok" | "denied" | "error";

/**
 * THE-1125: the ONE observation site opt-in telemetry (telemetry/collector.ts) taps to build its
 * own per-tool and per-error-code counts, instead of a second call site instrumenting
 * `mcp/registry/dispatch.ts` a second time. `observeToolCall` below is already the single method
 * every dispatch.ts call site funnels through (success and every error branch); a telemetry
 * observer registered here sees exactly the same calls Prometheus's `obsidian_tc_tool_calls_total`
 * does, with nothing new to keep in sync.
 *
 * Deliberately a narrow, telemetry-agnostic interface (not a dependency on
 * `TelemetryCollector` itself) so this metrics-only module never imports from `telemetry/` —
 * the composition root (runtime/observability.ts) is the only place that knows both exist.
 */
export interface ToolCallObserver {
  onToolCall(
    tool: string,
    status: ToolCallStatus,
    detail?: { errorCode?: string; facadeMode?: string; clientName?: string },
  ): void;
}
