// Child spans under the per-request root span (observability.otel.detail). Kept in its own module
// so dispatch.ts and policy-gates.ts carry one-line stage markers instead of span plumbing.
//
// Levels: "root" creates nothing (openDispatchSpans returns undefined, so a call allocates no span
// state and sets no attribute); "children" adds one span per pipeline stage; "verbose" also adds
// per-item spans for batch tools and SQLite transaction spans, both capped per request.
//
// Only @opentelemetry/api is imported (already in the published barrel's graph); the SDK stays
// lazy (see tracing.ts). Every string attribute passes the shared credential scanner, and a failure
// is recorded as its structured error code ONLY: no exception event, no message, no stack.
import {
  type Context,
  context,
  createContextKey,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { ObsidianTcError, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { redactSecrets } from "../experiential/redact";
import { SPAN_ATTR } from "./attrs";

/** "root" | "children" | "verbose": the config enum is the single source of the literal set. */
export type OtelDetail = ServerConfig["observability"]["otel"]["detail"];

/** Hard bound on non-root spans per request. The pipeline has at most STAGE_RESERVE stages, which
 *  always get a span; batch-item and db spans share the remainder and are dropped past it. */
export const MAX_SPANS_PER_REQUEST = 64;
const STAGE_RESERVE = 10;

const REQUEST_SPANS = createContextKey("obsidian_tc.dispatch_spans");

// Fast-path guard for the handler-side helpers: false until some registry opts into "verbose", so
// a default deployment pays one boolean read per db transaction / batch item.
let verboseRequested = false;
export function requestVerboseSpans(): void {
  verboseRequested = true;
}

const safe = (s: string): string => redactSecrets(s).text;

function markError(span: Span, rawCode: string): void {
  const code = safe(rawCode);
  span.setAttribute(SPAN_ATTR.errorCode, code);
  span.setStatus({ code: SpanStatusCode.ERROR, message: code });
}

const codeOf = (e: unknown): string => (e instanceof ObsidianTcError ? e.code : "internal");

export class DispatchSpans {
  private open: Span | undefined;
  private extras = 0;
  private dropped = 0;

  constructor(
    private readonly tracer: Tracer,
    private readonly parent: Context,
    private readonly root: Span,
    readonly verbose: boolean,
  ) {}

  /** Ends the current stage span (if any) and starts `name` as a child of the root. */
  stage(name: string): void {
    this.open?.end();
    this.open = this.tracer.startSpan(name, undefined, this.parent);
  }

  /** Marks the current stage span as failed with a structured error code. */
  fail(code: string): void {
    if (this.open) markError(this.open, code);
  }

  /** Runs `fn` with the current stage span active, so verbose helpers inside it parent correctly. */
  activate<T>(fn: () => T): T {
    if (!this.verbose || !this.open) return fn();
    const ctx = trace.setSpan(this.parent, this.open).setValue(REQUEST_SPANS, this);
    return context.with(ctx, fn);
  }

  close(): void {
    this.open?.end();
    this.open = undefined;
    if (this.dropped > 0) this.root.setAttribute(SPAN_ATTR.spansDropped, this.dropped);
  }

  /** @internal a verbose extra span, or undefined once the per-request budget is spent. */
  startExtra(name: string): Span | undefined {
    if (this.extras >= MAX_SPANS_PER_REQUEST - STAGE_RESERVE) {
      this.dropped++;
      return undefined;
    }
    this.extras++;
    return this.tracer.startSpan(name, undefined, context.active());
  }
}

/** undefined (and so zero work per call) unless a tracer exists and detail is above "root". */
export function openDispatchSpans(
  tracer: Tracer | undefined,
  detail: OtelDetail | undefined,
  root: Span | undefined,
): DispatchSpans | undefined {
  if (!tracer || !root || detail === undefined || detail === "root") return undefined;
  return new DispatchSpans(
    tracer,
    trace.setSpan(context.active(), root),
    root,
    detail === "verbose",
  );
}

function isThenable<T>(v: T | PromiseLike<T>): v is PromiseLike<T> {
  return typeof (v as { then?: unknown } | null)?.then === "function";
}

function runExtra<T>(name: string, index: number | undefined, fn: () => T): T {
  if (!verboseRequested) return fn();
  const req = context.active().getValue(REQUEST_SPANS) as DispatchSpans | undefined;
  const span = req?.startExtra(name);
  if (!span) return fn();
  if (index !== undefined) span.setAttribute(SPAN_ATTR.itemIndex, index);
  let out: T;
  try {
    out = context.with(trace.setSpan(context.active(), span), fn);
  } catch (e) {
    markError(span, codeOf(e));
    span.end();
    throw e;
  }
  if (!isThenable(out)) {
    span.end();
    return out;
  }
  return out.then(
    (v) => {
      span.end();
      return v;
    },
    (e) => {
      markError(span, codeOf(e));
      span.end();
      throw e;
    },
  ) as T;
}

/** One span per batch item (verbose only). Carries the item index, never the item itself. */
export function traceItem<T>(name: string, fn: () => T, index?: number): T {
  return runExtra(name, index, fn);
}

/** A SQLite transaction / savepoint span (verbose only). */
export function traceDb<T>(name: string, fn: () => T): T {
  return runExtra(name, undefined, fn);
}
