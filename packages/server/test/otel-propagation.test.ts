// SEP-414 (MCP 2026-07-28): W3C trace context over MCP `_meta`.
//
// Two layers, tested separately for the reason THE-649 made expensive: the carrier parsing is pure
// policy over untrusted input and must be asserted without any OTEL machinery, while the "does the
// span actually get re-parented" claim needs a real propagator and is the only part that does.
//
// The second one matters most. `extractTraceCarrier` returning the right object proves nothing about
// whether a trace actually continues — that is the [[feedback-registered-is-not-emitting]] shape, and
// the assertion has to be on the resulting span's traceId.
import { trace } from "@opentelemetry/api";
// Only `@opentelemetry/sdk-trace-node` is imported, and only because it is a real dependency of this
// package — `@opentelemetry/core` (where the propagators live) is transitive, and importing it here
// would be a phantom dependency the THE-593 dev-dep gate exists to catch.
//
// That constraint turned out to improve the test: using NodeTracerProvider.register() exercises the
// SAME call initOtel makes, so the propagator under test is the one production actually installs
// rather than a hand-built replica of it that could drift.
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractTraceCarrier, TRACE_CARRIER_KEYS, withTraceCarrier } from "../src/otel/propagation";

// A real, syntactically valid traceparent: version-traceId-spanId-flags (sampled).
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

describe("extractTraceCarrier — untrusted `_meta` parsing", () => {
  it("lifts all three SEP-414 keys", () => {
    // The key names are the whole point of the SEP — several SDKs were already propagating trace
    // context under names of their own choosing, so nothing correlated. Pin them explicitly.
    expect(TRACE_CARRIER_KEYS).toEqual(["traceparent", "tracestate", "baggage"]);
    expect(
      extractTraceCarrier({ traceparent: TRACEPARENT, tracestate: "vendor=x", baggage: "k=v" }),
    ).toEqual({ traceparent: TRACEPARENT, tracestate: "vendor=x", baggage: "k=v" });
  });

  it("returns undefined when there is nothing to propagate, so the caller can skip the work", () => {
    expect(extractTraceCarrier(undefined)).toBeUndefined();
    expect(extractTraceCarrier(null)).toBeUndefined();
    expect(extractTraceCarrier({})).toBeUndefined();
    // A `_meta` carrying only unrelated keys is the common case — MCP `_meta` is a general-purpose
    // bag, so most requests will have one with nothing trace-related in it.
    expect(
      extractTraceCarrier({ "io.modelcontextprotocol/clientInfo": { name: "x" } }),
    ).toBeUndefined();
    expect(extractTraceCarrier("not an object")).toBeUndefined();
    expect(extractTraceCarrier(42)).toBeUndefined();
  });

  it("takes a partial carrier — traceparent alone is the normal case", () => {
    expect(extractTraceCarrier({ traceparent: TRACEPARENT })).toEqual({ traceparent: TRACEPARENT });
  });

  it("ignores non-string and empty values rather than passing them to the parser", () => {
    expect(
      extractTraceCarrier({ traceparent: 123, tracestate: null, baggage: { k: "v" } }),
    ).toBeUndefined();
    expect(extractTraceCarrier({ traceparent: "" })).toBeUndefined();
  });

  it("DROPS an over-long value instead of truncating it", () => {
    // Untrusted client input handed to a parser gets a bound. Dropping beats truncating: a truncated
    // tracestate is a corrupt tracestate, and silently altering a caller's trace data is worse than
    // ignoring it. Limits are the W3C ones (tracestate 512, baggage 8192).
    const longState = "a".repeat(513);
    const longBaggage = "b".repeat(8193);
    expect(extractTraceCarrier({ traceparent: TRACEPARENT, tracestate: longState })).toEqual({
      traceparent: TRACEPARENT,
    });
    expect(extractTraceCarrier({ traceparent: TRACEPARENT, baggage: longBaggage })).toEqual({
      traceparent: TRACEPARENT,
    });
    // And a value at the limit is KEPT — otherwise "drops long values" could pass by dropping
    // everything, which is the failure this pairs against.
    expect(
      extractTraceCarrier({ traceparent: TRACEPARENT, tracestate: "a".repeat(512) })?.tracestate,
    ).toHaveLength(512);
  });

  it("does not re-implement traceparent grammar — a malformed value is passed to the propagator", () => {
    // Deliberate: W3CTraceContextPropagator already rejects malformed values (and then yields no
    // parent). A second, drifting copy of that grammar here would be a liability. What IS enforced
    // is that the value is a bounded string; validity is the propagator's job.
    expect(extractTraceCarrier({ traceparent: "garbage" })).toEqual({ traceparent: "garbage" });
  });
});

describe("withTraceCarrier — the span is actually re-parented", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;

  beforeAll(() => {
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    // register() with NO propagator argument — the exact call initOtel makes. NodeTracerProvider
    // then installs a CompositePropagator of W3CTraceContextPropagator + W3CBaggagePropagator as the
    // global propagator, which is why propagation.ts registers nothing of its own. If that default
    // ever changes upstream, these tests fail rather than propagation.ts silently going inert.
    provider.register();
  });
  afterAll(async () => {
    await provider.shutdown();
  });

  const spanUnder = (carrier: Parameters<typeof withTraceCarrier>[0]) => {
    exporter.reset();
    withTraceCarrier(carrier, () => {
      trace.getTracer("test").startActiveSpan("child", (s) => s.end());
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1); // floor: a dropped span would make every claim below vacuous
    return spans[0];
  };

  it("adopts the caller's traceId and parent span — the whole point of the SEP", () => {
    const span = spanUnder({ traceparent: TRACEPARENT });
    expect(span?.spanContext().traceId).toBe(TRACE_ID);
    expect(span?.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
  });

  it("starts a ROOT span when no carrier is present — the pre-SEP-414 behaviour, unchanged", () => {
    const span = spanUnder(undefined);
    expect(span?.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span?.parentSpanContext).toBeUndefined();
  });

  it("degrades to a root span on a MALFORMED carrier rather than losing the span", () => {
    // The failure mode that matters operationally: a broken upstream must cost you correlation, not
    // observability. Losing the span entirely would be strictly worse than never propagating.
    const span = spanUnder({ traceparent: "garbage" });
    expect(span?.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span?.parentSpanContext).toBeUndefined();
  });

  it("degrades to a root span when only baggage is sent (no traceparent)", () => {
    const span = spanUnder({ baggage: "k=v" });
    expect(span?.parentSpanContext).toBeUndefined();
  });

  it("honours the caller's SAMPLING decision — an unsampled parent suppresses our span entirely", () => {
    // A real behaviour change, and the one thing here an operator could be surprised by.
    //
    // Before SEP-414 every dispatch span was a ROOT span, and the default ParentBasedSampler falls
    // back to AlwaysOn at the root — so we exported one span per tool call, always. Now, a caller
    // that sends a traceparent with the sampled flag CLEAR (`-00`) makes our span a child of an
    // unsampled parent, and ParentBased then samples it out. Zero spans exported for that call.
    //
    // That is correct and desirable: emitting a span into a trace the host discarded produces an
    // orphan nobody can assemble. But it means "we stopped seeing spans from client X" can now be
    // client X declining to sample rather than anything broken here, which is worth knowing before
    // debugging it as an outage.
    exporter.reset();
    withTraceCarrier({ traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-00` }, () => {
      trace.getTracer("test").startActiveSpan("child", (s) => s.end());
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("records and exports when the caller's trace IS sampled", () => {
    // Pairs with the above: without it, "unsampled exports nothing" would also pass against an
    // implementation that exports nothing ever.
    const sampled = spanUnder({ traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01` });
    expect(sampled?.spanContext().traceFlags).toBe(1);
    expect(sampled?.spanContext().traceId).toBe(TRACE_ID);
  });
});
