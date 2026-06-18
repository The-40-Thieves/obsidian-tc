import {
  ObsidianTcError,
  type ToolResult,
  grantsAll,
  isMutatingScope,
  scopeClassOf,
  scopeRequiresHitl,
} from "@obsidian-tc/shared";
import { type Span, SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { z } from "zod";
import type { FolderAcl } from "../acl";
import { type AuditEvent, writeEvent } from "../audit";
import type { Database } from "../db/types";
import { argsHash } from "../hash";
import type { MetricsRecorder, ToolCallStatus } from "../metrics/registry";
import { SPAN_ATTR } from "../otel/tracing";
import { callerHash } from "../throttle";

export interface CallerContext {
  caller: string | null;
  authenticated: boolean;
  grantedScopes: Set<string>;
  vaultId: string;
  db: Database;
  elicitToken?: string | null;
  acl?: FolderAcl;
  now?: () => number;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  requiredScopes: string[];
  destructive?: boolean;
  handler: (input: I, ctx: CallerContext) => Promise<O> | O;
}

type VerifyElicit = (token: string, expectedHash: string, ctx: CallerContext) => boolean;
type Status = "ok" | "error" | "skipped";

/** Map a terminal error code to the G2.4 tool-call status label (ok | denied | error). */
function callStatusForError(code: string): ToolCallStatus {
  switch (code) {
    case "unauthorized":
    case "forbidden":
    case "elicit_required":
    case "throttled":
      return "denied";
    default:
      return "error";
  }
}

/** Set the G2.4 result attributes + span status on the root span from a dispatch outcome. */
function annotateSpanResult(span: Span, result: ToolResult): void {
  span.setAttribute(SPAN_ATTR.durationMs, result.meta.duration_ms);
  if (result.ok) {
    span.setAttribute(SPAN_ATTR.status, "ok");
    span.setAttribute(SPAN_ATTR.rateLimitHit, false);
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }
  const code = result.error.code;
  span.setAttribute(SPAN_ATTR.status, callStatusForError(code));
  span.setAttribute(SPAN_ATTR.errorCode, code);
  span.setAttribute(SPAN_ATTR.rateLimitHit, code === "throttled");
  if (typeof result.meta.overflow_bytes === "number") {
    span.setAttribute(SPAN_ATTR.overflowB, result.meta.overflow_bytes);
  }
  // Error spans are always recorded (G2.4: sampled regardless of trace rate).
  span.setStatus({ code: SpanStatusCode.ERROR, message: code });
}

export interface RegistryOptions {
  maxResponseBytes?: number;
  verifyElicit?: VerifyElicit;
  /** Prometheus recorder (G2.4). Optional: dispatch records nothing when it is absent. */
  metrics?: MetricsRecorder;
  /** OTEL tool tracer (G2.4). Optional: dispatch emits no spans when it is absent. */
  tracer?: Tracer;
}

export class ToolRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool registry; the handler input type is contravariant, so ToolDefinition<unknown, unknown> is not assignable from a specific ToolDefinition.
  private readonly tools = new Map<string, ToolDefinition<any, any>>();
  private readonly maxResponseBytes: number;
  private readonly verifyElicit?: VerifyElicit;
  private readonly metrics?: MetricsRecorder;
  private readonly tracer?: Tracer;

  constructor(opts: RegistryOptions = {}) {
    this.maxResponseBytes = opts.maxResponseBytes ?? 1_000_000;
    this.verifyElicit = opts.verifyElicit;
    this.metrics = opts.metrics;
    this.tracer = opts.tracer;
  }

  /** Record into the Prometheus recorder; a metrics error must never break dispatch (G2.4). */
  private meter(fn: (m: MetricsRecorder) => void): void {
    const m = this.metrics;
    if (!m) return;
    try {
      fn(m);
    } catch {
      /* observability must never block tool execution */
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts any specific ToolDefinition for storage in the heterogeneous registry (see the tools map above).
  register(def: ToolDefinition<any, any>): void {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    this.tools.set(def.name, def);
  }
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }

  // One OTEL root span per tool call (G2.4) wraps the pipeline when a tracer is configured;
  // otherwise the tracer-less fast path runs unchanged. Span attributes come from ctx + the
  // ToolResult, so runDispatch's internals stay untouched.
  async dispatch(name: string, rawInput: unknown, ctx: CallerContext): Promise<ToolResult> {
    const tracer = this.tracer;
    if (!tracer) return this.runDispatch(name, rawInput, ctx);
    return tracer.startActiveSpan(
      `obsidian_tc.${name}`,
      { kind: SpanKind.SERVER },
      async (span) => {
        try {
          span.setAttribute(SPAN_ATTR.vaultId, ctx.vaultId);
          span.setAttribute(SPAN_ATTR.tool, name);
          span.setAttribute(SPAN_ATTR.callerHash, callerHash(ctx.caller));
          span.setAttribute(
            SPAN_ATTR.scopesRequired,
            (this.tools.get(name)?.requiredScopes ?? []).join(","),
          );
          span.setAttribute(SPAN_ATTR.elicitUsed, !!ctx.elicitToken);
          const result = await this.runDispatch(name, rawInput, ctx);
          annotateSpanResult(span, result);
          return result;
        } finally {
          span.end();
        }
      },
    );
  }

  // Full invocation pipeline: validate -> auth -> scope/ACL -> HITL -> execute -> governor -> audit.
  private async runDispatch(
    name: string,
    rawInput: unknown,
    ctx: CallerContext,
  ): Promise<ToolResult> {
    const now = ctx.now ?? Date.now;
    const start = now();
    const hash = argsHash(name, rawInput ?? {});
    // Governing scope class for the limiter gate + `scope_class` metric label; resolved
    // once the tool definition is known (stays "unknown" for an unrecognized tool name).
    let scopeClass = "unknown";

    const audit = (status: Status, durationMs: number, resultSize: number, code?: string) => {
      try {
        const e: AuditEvent = {
          ts: Date.now(),
          vault_id: ctx.vaultId,
          tool_name: name,
          caller: ctx.caller,
          duration_ms: durationMs,
          result_size: resultSize,
          status,
          error_code: code ?? null,
          args_hash: hash,
          event_type: "tool_invocation",
        };
        writeEvent(ctx.db, e);
      } catch {
        /* audit must never break dispatch */
      }
    };

    try {
      const def = this.tools.get(name);
      if (!def) throw new ObsidianTcError("not_found", `unknown tool: ${name}`);
      scopeClass = scopeClassOf(def.requiredScopes);

      const parsed = def.inputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new ObsidianTcError("validation_error", "input validation failed", {
          issues: parsed.error.issues,
        });

      if (def.requiredScopes.length > 0 && !ctx.authenticated)
        throw new ObsidianTcError("unauthorized", "authentication required for this tool");

      if (!grantsAll(ctx.grantedScopes, def.requiredScopes))
        throw new ObsidianTcError("forbidden", "missing required scope(s)", {
          required: def.requiredScopes,
        });

      const mutating = def.destructive === true || def.requiredScopes.some(isMutatingScope);
      if (mutating && ctx.acl?.readOnly)
        throw new ObsidianTcError("forbidden", "vault is read-only (acl.readOnly)");

      const needsHitl = def.destructive === true || def.requiredScopes.some(scopeRequiresHitl);
      if (needsHitl) {
        const ok =
          !!ctx.elicitToken && !!this.verifyElicit && this.verifyElicit(ctx.elicitToken, hash, ctx);
        if (!ok) {
          this.meter((m) => m.incHitlElicited(ctx.vaultId, name));
          throw new ObsidianTcError("elicit_required", "human confirmation required", {
            args_hash: hash,
          });
        }
      }

      const out = await def.handler(parsed.data, ctx);
      const json = JSON.stringify(out ?? null);
      const resultSize = Buffer.byteLength(json, "utf8");
      const duration = Math.max(0, now() - start);

      if (resultSize > this.maxResponseBytes) {
        const e = new ObsidianTcError("overflow", "response exceeds byte budget", {
          result_size: resultSize,
          limit: this.maxResponseBytes,
        });
        audit("error", duration, resultSize, e.code);
        this.meter((m) => {
          m.incGovernorTruncation(ctx.vaultId, name);
          m.observeToolCall(ctx.vaultId, name, "error", duration / 1000, resultSize);
        });
        return {
          ok: false,
          error: e.toJSON(),
          meta: {
            duration_ms: duration,
            result_size: resultSize,
            overflow_bytes: resultSize - this.maxResponseBytes,
          },
        };
      }

      audit("ok", duration, resultSize);
      this.meter((m) => m.observeToolCall(ctx.vaultId, name, "ok", duration / 1000, resultSize));
      return { ok: true, data: out, meta: { duration_ms: duration, result_size: resultSize } };
    } catch (e) {
      const error =
        e instanceof ObsidianTcError ? e : new ObsidianTcError("internal", (e as Error).message);
      const duration = Math.max(0, now() - start);
      audit("error", duration, 0, error.code);
      this.meter((m) => {
        if (error.code === "forbidden") m.incAclDenied(ctx.vaultId, scopeClass, error.code);
        m.observeToolCall(ctx.vaultId, name, callStatusForError(error.code), duration / 1000, 0);
      });
      return { ok: false, error: error.toJSON(), meta: { duration_ms: duration, result_size: 0 } };
    }
  }
}
