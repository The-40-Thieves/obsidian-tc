// SEP-414 (MCP 2026-07-28) — W3C Trace Context propagation over MCP `_meta`.
//
// Before this, a trace that began in a host application stopped dead at our edge: we emitted a
// SERVER span per tool call, but it was always a ROOT span, so the host's trace and ours were two
// unrelated trees in the backend. The tool call is the interesting hop and it was exactly the one
// you could not follow.
//
// The spec change is small and the reason it matters is that it is a NAMING agreement: several SDKs
// were already stuffing trace context into `_meta` under keys of their own choosing, so nothing
// correlated across implementations. SEP-414 fixes `traceparent`, `tracestate` and `baggage`, which
// are precisely the keys OTEL's own W3C propagators already read.
//
// Which is why this file registers nothing. `initOtel` calls `provider.register()` with no
// propagator argument, and NodeTracerProvider then installs a CompositePropagator of
// W3CTraceContextPropagator + W3CBaggagePropagator as the global propagator (verified against the
// SDK source, not recalled). So `propagation.extract` already understands all three keys — the only
// thing missing was handing it the carrier.
//
// This is forward-compatible on purpose: `_meta` passthrough exists in the CURRENT spec too, so
// this works under `2025-11-25` today and under `2026-07-28` after the SDK migration (THE-583),
// with no second implementation.
import { type Context, context, propagation } from "@opentelemetry/api";

/** The three key names SEP-414 fixes. Not configurable — the whole point is that they are agreed. */
export const TRACE_CARRIER_KEYS = ["traceparent", "tracestate", "baggage"] as const;

export type TraceCarrier = Record<string, string>;

/**
 * Per-key length ceilings. This carrier is UNTRUSTED CLIENT INPUT handed to a parser, so it gets a
 * bound before it gets there.
 *
 * The numbers are the W3C limits: `traceparent` is a fixed 55-char form (128 leaves room for a
 * future version without being a blank cheque), `tracestate` is capped at 512, and `baggage` at
 * 8192. An over-long value is DROPPED, never truncated — a truncated `tracestate` is a corrupt
 * `tracestate`, and silently changing a caller's trace data is worse than ignoring it.
 */
const MAX_LEN: Record<(typeof TRACE_CARRIER_KEYS)[number], number> = {
  traceparent: 128,
  tracestate: 512,
  baggage: 8192,
};

/**
 * Pull a W3C trace carrier out of an MCP `_meta` object.
 *
 * Returns `undefined` when there is nothing to propagate, so the caller can skip the context work
 * entirely rather than build an empty context on every call.
 *
 * Deliberately does NOT validate `traceparent`'s grammar: `W3CTraceContextPropagator` already
 * rejects a malformed value (and then simply yields no parent), and a second, drifting copy of that
 * grammar here would be a liability rather than a defence. What this DOES enforce is the part the
 * propagator will not — that the values are strings and bounded.
 */
export function extractTraceCarrier(meta: unknown): TraceCarrier | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const src = meta as Record<string, unknown>;
  let out: TraceCarrier | undefined;
  for (const key of TRACE_CARRIER_KEYS) {
    const v = src[key];
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_LEN[key]) continue;
    out ??= {};
    out[key] = v;
  }
  return out;
}

/**
 * Run `fn` with the caller's trace context active, so a span started inside becomes a CHILD of the
 * host application's span rather than a new root.
 *
 * A carrier that is absent, malformed, or carries only `baggage` all degrade the same safe way: the
 * extracted context simply has no span parent and the span is a root, exactly as before this
 * existed. There is no failure mode here that loses a span.
 */
export function withTraceCarrier<T>(carrier: TraceCarrier | undefined, fn: () => T): T {
  if (carrier === undefined) return fn();
  return context.with(extractContext(carrier), fn);
}

/** The extraction step alone — exported so a test can assert the resulting context directly. */
export function extractContext(carrier: TraceCarrier): Context {
  return propagation.extract(context.active(), carrier);
}
