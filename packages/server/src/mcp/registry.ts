import { type Span, SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import {
  err,
  grantsAll,
  isMutatingScope,
  type MorgianaEventData,
  type MorgianaEventType,
  ObsidianTcError,
  scopeClassOf,
  scopeRequiresHitl,
  type ToolResult,
  type ToolVisibilityConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import type { z } from "zod";
import type { FolderAcl } from "../acl";
import { type AuditEvent, writeEvent } from "../audit";
import type { Database } from "../db/types";
import { argsHash } from "../hash";
import type { MetricsRecorder, ToolCallStatus } from "../metrics/registry";
import { SPAN_ATTR } from "../otel/tracing";
import { callerHash, type RateLimiter } from "../throttle";
import { ALLOW_ALL, isDisabled, isListed, type VisibilityCaller } from "./visibility";

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
  /** Free-form classification labels for tool-visibility scoping (THE-219):
   *  matched against toolVisibility.hiddenTags / disabledTags. */
  tags?: string[];
  destructive?: boolean;
  /** Tool-specific precondition gate. Runs AFTER scope+ACL and BEFORE the HITL/elicit
   *  stage, so a rejection never consumes the single-use elicit token (D5). Throw an
   *  ObsidianTcError to reject. */
  precheck?: (input: I, ctx: CallerContext) => Promise<void> | void;
  /** Override the governing throttle/metric scope class (E4). Defaults to scopeClassOf(requiredScopes). */
  scopeClass?: string;
  handler: (input: I, ctx: CallerContext) => Promise<O> | O;
}

type VerifyElicit = (token: string, expectedHash: string, ctx: CallerContext) => boolean;
type Status = "ok" | "error" | "skipped";

/** Map a terminal error code to the G2.4 tool-call status label (ok | denied | error). */
function callStatusForError(code: string): ToolCallStatus {
  switch (code) {
    case "unauthorized":
    case "forbidden":
    case "acl_denied":
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

/** The whole-operation idempotency key for a call, if any (D3). Reads a top-level
 *  `idempotency_key`, the `bulk_idempotency_key` alias, or a nested
 *  `options.idempotency_key`; never a per-item `items[].idempotency_key`. */
function extractIdempotencyKey(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const o = data as Record<string, unknown>;
  const top = o.idempotency_key ?? o.bulk_idempotency_key;
  if (typeof top === "string" && top.length > 0) return top;
  const opts = o.options;
  if (opts !== null && typeof opts === "object") {
    const nested = (opts as Record<string, unknown>).idempotency_key;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return undefined;
}

/** Coerce a SQLite result column (string | Buffer | Uint8Array) to a UTF-8 string. */
function bufToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array)
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8");
  return String(v ?? "");
}

export interface RegistryOptions {
  maxResponseBytes?: number;
  verifyElicit?: VerifyElicit;
  /** Prometheus recorder (G2.4). Optional: dispatch records nothing when it is absent. */
  metrics?: MetricsRecorder;
  /** OTEL tool tracer (G2.4). Optional: dispatch emits no spans when it is absent. */
  tracer?: Tracer;
  /** MORGIANA event sink (G2.4). Optional: dispatch emits no CloudEvents when it is absent. */
  emit?: (vaultId: string, type: MorgianaEventType, data: Partial<MorgianaEventData>) => void;
  /** Dispatch-wide rate limiter (THE-210). Optional: no rate gate when it is absent. */
  rateLimiter?: RateLimiter;
  /** Idempotency replay TTL in seconds (D3). Defaults to 86400 when absent. */
  idempotencyTtlSeconds?: number;
  /** Static tool-visibility scoping (THE-219). Optional: ALLOW_ALL when absent. */
  toolVisibility?: ToolVisibilityConfig;
}

export class ToolRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool registry; the handler input type is contravariant, so ToolDefinition<unknown, unknown> is not assignable from a specific ToolDefinition.
  private readonly tools = new Map<string, ToolDefinition<any, any>>();
  private readonly maxResponseBytes: number;
  private readonly verifyElicit?: VerifyElicit;
  private readonly metrics?: MetricsRecorder;
  private readonly tracer?: Tracer;
  private readonly emit?: (
    vaultId: string,
    type: MorgianaEventType,
    data: Partial<MorgianaEventData>,
  ) => void;
  private readonly rateLimiter?: RateLimiter;
  private readonly idempotencyTtlMs: number;
  private readonly toolVisibility: ToolVisibilityConfig;

  constructor(opts: RegistryOptions = {}) {
    this.maxResponseBytes = opts.maxResponseBytes ?? 1_000_000;
    this.verifyElicit = opts.verifyElicit;
    this.metrics = opts.metrics;
    this.tracer = opts.tracer;
    this.emit = opts.emit;
    this.rateLimiter = opts.rateLimiter;
    this.idempotencyTtlMs = (opts.idempotencyTtlSeconds ?? 86400) * 1000;
    this.toolVisibility = opts.toolVisibility ?? ALLOW_ALL;
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

  /** Emit one MORGIANA CloudEvent; a sink error must never break dispatch (G2.4 fail-soft). */
  private relay(vaultId: string, type: MorgianaEventType, data: Partial<MorgianaEventData>): void {
    if (!this.emit) return;
    try {
      this.emit(vaultId, type, data);
    } catch {
      /* MORGIANA emission must never block tool execution */
    }
  }

  /** The shared CloudEvents data payload for a completed call. */
  private morgianaData(
    name: string,
    ctx: CallerContext,
    result: ToolResult,
  ): Partial<MorgianaEventData> {
    return {
      tool: name,
      caller_hash: callerHash(ctx.caller),
      scopes_required: this.tools.get(name)?.requiredScopes ?? [],
      status: result.ok ? "ok" : callStatusForError(result.error.code),
      duration_ms: result.meta.duration_ms,
      elicit_token: ctx.elicitToken ?? null,
      result_size: result.meta.result_size,
      overflow_bytes: result.meta.overflow_bytes ?? null,
      error: result.ok ? null : { code: result.error.code, message: result.error.message },
    };
  }

  /** Per-call MORGIANA events: always tc.tool.call.completed, plus the specific signal if any. */
  private emitCompletion(name: string, ctx: CallerContext, result: ToolResult): void {
    if (!this.emit) return;
    const data = this.morgianaData(name, ctx, result);
    this.relay(ctx.vaultId, "tc.tool.call.completed", data);
    if (result.ok) {
      if (name === "reset_vault_cache") this.relay(ctx.vaultId, "tc.vault.cache_reset", data);
      return;
    }
    switch (result.error.code) {
      case "forbidden":
      case "acl_denied":
        this.relay(ctx.vaultId, "tc.acl.denied", data);
        break;
      case "overflow":
        this.relay(ctx.vaultId, "tc.governor.overflow", data);
        break;
      case "elicit_required":
        this.relay(ctx.vaultId, "tc.elicit.requested", data);
        break;
      case "throttled":
        this.relay(ctx.vaultId, "tc.rate_limit.hit", data);
        break;
    }
  }

  /** Try to atomically claim the in-flight idempotency slot for (vault, key). */
  private tryClaimIdempotency(
    db: Database,
    vaultId: string,
    key: string,
    tool: string,
    argsHashValue: string,
    nowMs: number,
  ): "claimed" | "exists" {
    try {
      db.prepare(
        "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)",
      ).run(vaultId, key, tool, argsHashValue, nowMs, nowMs + this.idempotencyTtlMs);
      return "claimed";
    } catch (e) {
      if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test((e as Error).message)) return "exists";
      throw e;
    }
  }

  private readIdempotency(
    db: Database,
    vaultId: string,
    key: string,
  ):
    | {
        tool_name: string;
        args_hash: string;
        started_at: number;
        completed_at: number | null;
        result: unknown;
        result_size: number | null;
        expires_at: number;
      }
    | undefined {
    return db
      .prepare(
        "SELECT tool_name, args_hash, started_at, completed_at, result, result_size, expires_at FROM idempotency_keys WHERE vault_id = ? AND key = ?",
      )
      .get(vaultId, key) as
      | {
          tool_name: string;
          args_hash: string;
          started_at: number;
          completed_at: number | null;
          result: unknown;
          result_size: number | null;
          expires_at: number;
        }
      | undefined;
  }

  private finalizeIdempotency(
    db: Database,
    vaultId: string,
    key: string,
    json: string,
    size: number,
    nowMs: number,
  ): void {
    db.prepare(
      "UPDATE idempotency_keys SET completed_at = ?, result = ?, result_size = ? WHERE vault_id = ? AND key = ?",
    ).run(nowMs, json, size, vaultId, key);
  }

  private deleteIdempotency(db: Database, vaultId: string, key: string): void {
    db.prepare("DELETE FROM idempotency_keys WHERE vault_id = ? AND key = ?").run(vaultId, key);
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts any specific ToolDefinition for storage in the heterogeneous registry (see the tools map above).
  register(def: ToolDefinition<any, any>): void {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    this.tools.set(def.name, def);
  }
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }
  /** Tools advertised by tools/list: the registered set minus those the visibility config
   *  hides/disables (THE-219) and those the caller cannot dispatch (THE-250). `list()` stays
   *  the full registered set. */
  listVisible(caller?: VisibilityCaller): ToolDefinition[] {
    return [...this.tools.values()].filter((def) => isListed(def, this.toolVisibility, caller));
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }

  // One OTEL root span per tool call (G2.4) wraps the pipeline when a tracer is configured;
  // otherwise the tracer-less fast path runs unchanged. Span attributes come from ctx + the
  // ToolResult, so runDispatch's internals stay untouched.
  async dispatch(name: string, rawInput: unknown, ctx: CallerContext): Promise<ToolResult> {
    const tracer = this.tracer;
    if (!tracer) {
      const result = await this.runDispatch(name, rawInput, ctx);
      this.emitCompletion(name, ctx, result);
      return result;
    }
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
          this.emitCompletion(name, ctx, result);
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
    // Idempotency gate state (D3): set when the call carries an idempotency key and
    // we own its in-flight row, so the catch/overflow paths can release it.
    let idemKey: string | undefined;
    let idemClaimed = false;

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
      // THE-219 dispatch guard: a disabled tool is removed from the surface entirely.
      // Reject before scope/validation with the same error an unregistered tool yields,
      // so a disabled tool is indistinguishable from one that was never registered.
      if (isDisabled(def, this.toolVisibility))
        throw new ObsidianTcError("not_found", `unknown tool: ${name}`);
      scopeClass = def.scopeClass ?? scopeClassOf(def.requiredScopes);

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

      // Tool-specific precondition gate (D5). After scope/ACL, before HITL, so a
      // rejected precheck never consumes the single-use elicit token.
      if (def.precheck) await def.precheck(parsed.data, ctx);

      // Idempotency gate (D3). A keyed call claims a row in idempotency_keys; a
      // replay returns the cached result without re-running the handler. Runs after
      // auth/scope/ACL/precheck but BEFORE HITL/throttle: the lock must be claimed
      // atomically before the single-use elicit token is consumed to prevent a TOCTOU
      // race where two concurrent identical requests each consume the token.
      // Authorization (auth/scope/ACL) still runs before this gate, so it stays
      // authoritative on replays.
      idemKey = extractIdempotencyKey(parsed.data);
      if (idemKey) {
        if (
          this.tryClaimIdempotency(ctx.db, ctx.vaultId, idemKey, name, hash, now()) === "claimed"
        ) {
          idemClaimed = true;
        } else {
          let row = this.readIdempotency(ctx.db, ctx.vaultId, idemKey);
          // Reclaim an expired or crashed (in-flight past the 60s sweep) row, then retry once.
          if (
            row &&
            (row.expires_at <= now() ||
              (row.completed_at == null && row.started_at + 60_000 <= now()))
          ) {
            this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
            if (
              this.tryClaimIdempotency(ctx.db, ctx.vaultId, idemKey, name, hash, now()) ===
              "claimed"
            ) {
              idemClaimed = true;
            } else {
              row = this.readIdempotency(ctx.db, ctx.vaultId, idemKey);
            }
          }
          if (!idemClaimed) {
            if (!row)
              throw new ObsidianTcError("idempotency_in_flight", "operation in progress", {
                key: idemKey,
              });
            if (row.tool_name !== name || row.args_hash !== hash)
              throw new ObsidianTcError(
                "idempotency_key_mismatch",
                "idempotency key reused with a different tool or arguments",
                { key: idemKey },
              );
            if (row.completed_at != null) {
              try {
                const cachedStr = bufToString(row.result);
                const cached = JSON.parse(cachedStr) as unknown;
                const resultSize = row.result_size ?? Buffer.byteLength(cachedStr, "utf8");
                const duration = Math.max(0, now() - start);
                audit("ok", duration, resultSize);
                this.meter((m) =>
                  m.observeToolCall(ctx.vaultId, name, "ok", duration / 1000, resultSize),
                );
                return {
                  ok: true,
                  data: cached,
                  meta: { duration_ms: duration, result_size: resultSize },
                };
              } catch {
                // Corrupt cached blob: drop it (so the next call re-executes) and fail this one cleanly.
                this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
                throw new ObsidianTcError(
                  "internal",
                  "cached idempotent result was unreadable; retry",
                );
              }
            }
            throw new ObsidianTcError("idempotency_in_flight", "operation in progress", {
              key: idemKey,
            });
          }
        }
      }

      const needsHitl = def.destructive === true || def.requiredScopes.some(scopeRequiresHitl);
      if (needsHitl) {
        const ok =
          !!ctx.elicitToken && !!this.verifyElicit && this.verifyElicit(ctx.elicitToken, hash, ctx);
        if (!ok) {
          this.meter((m) => m.incHitlElicited(ctx.vaultId, name));
          if (idemClaimed && idemKey) {
            try {
              this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
            } catch {
              /* best-effort */
            }
          }
          throw new ObsidianTcError("elicit_required", "human confirmation required", {
            args_hash: hash,
          });
        }
        this.relay(ctx.vaultId, "tc.elicit.consumed", {
          tool: name,
          caller_hash: callerHash(ctx.caller),
          elicit_token: ctx.elicitToken ?? null,
        });
      }

      // Dispatch-wide rate-limit policy gate (THE-210, G2.4 §Rate limits). Per
      // (caller_hash, scope_class, vault); an unknown scope class is unlimited. Placed in the
      // policy layer (after scope/ACL/HITL), so it covers every tool, not just bulk.
      if (this.rateLimiter) {
        const decision = this.rateLimiter.check(
          callerHash(ctx.caller),
          scopeClass,
          ctx.vaultId,
          now(),
        );
        if (!decision.ok) {
          this.meter((m) => m.incRateLimitHit(ctx.vaultId, scopeClass));
          if (idemClaimed && idemKey) {
            try {
              this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
            } catch {
              /* best-effort */
            }
          }
          throw err.throttled("rate limit exceeded", {
            scope_class: decision.scopeClass,
            retry_after_seconds: decision.retryAfterSeconds,
            current_burst: decision.currentBurst,
            current_rate: decision.currentRate,
          });
        }
      }

      const out = await def.handler(parsed.data, ctx);
      const json = JSON.stringify(out ?? null);
      const resultSize = Buffer.byteLength(json, "utf8");
      const duration = Math.max(0, now() - start);

      if (resultSize > this.maxResponseBytes) {
        if (idemClaimed && idemKey) {
          try {
            this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
          } catch {
            /* best-effort cleanup */
          }
        }
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

      if (idemClaimed && idemKey)
        this.finalizeIdempotency(ctx.db, ctx.vaultId, idemKey, json, resultSize, now());
      audit("ok", duration, resultSize);
      this.meter((m) => m.observeToolCall(ctx.vaultId, name, "ok", duration / 1000, resultSize));
      return { ok: true, data: out, meta: { duration_ms: duration, result_size: resultSize } };
    } catch (e) {
      if (idemClaimed && idemKey) {
        try {
          this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
        } catch {
          /* cleanup best-effort; must not mask the original error */
        }
      }
      const error =
        e instanceof ObsidianTcError ? e : new ObsidianTcError("internal", "internal error");
      const duration = Math.max(0, now() - start);
      audit("error", duration, 0, error.code);
      this.meter((m) => {
        if (error.code === "forbidden" || error.code === "acl_denied")
          m.incAclDenied(ctx.vaultId, scopeClass, error.code);
        m.observeToolCall(ctx.vaultId, name, callStatusForError(error.code), duration / 1000, 0);
      });
      return { ok: false, error: error.toJSON(), meta: { duration_ms: duration, result_size: 0 } };
    }
  }
}
