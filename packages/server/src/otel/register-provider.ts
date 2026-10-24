// Installs the process-global OTEL state that the Node SDK's provider `register()` used to install.
// `@opentelemetry/sdk-trace` (the platform-neutral TracerProvider) registers nothing itself, so
// every caller that wants a live provider goes through here: the async-local-storage context
// manager (so handler-side spans parent through the request), the W3C trace-context + baggage
// propagators (so `_meta` carriers continue a host's trace), then the tracer provider.
//
// Loaded only through initOtel's lazy import, with the rest of the SDK, so the default-off path
// never evaluates these modules.
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import type { TracerProvider } from "@opentelemetry/sdk-trace";

export function registerTracerProvider(provider: TracerProvider): void {
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );
  trace.setGlobalTracerProvider(provider);
}
