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
import { cachedPrepare, type Database } from "../db/types";
import { argsHash } from "../hash";
import type { MetricsRecorder, ToolCallStatus } from "../metrics/registry";
import { SPAN_ATTR } from "../otel/tracing";
import { callerHash, type RateLimiter } from "../throttle";
import type { TraceRecord } from "../workspace/sessions";
import { ALLOW_ALL, isDisabled, isListed, type VisibilityCaller } from "./visibility";

export interface CallerContext {
  caller: string | null;
  authenticated: boolean;
  grantedScopes: Set<string>;
  vaultId: string;
  /** When true, the caller is bound to `vaultId` (HTTP tokens): a tool call whose `vault`
   *  argument names a different vault is rejected (THE-267), mirroring the resources/read guard.
   *  The trusted stdio context leaves this unset so the local operator addresses every vault. */
  vaultBound?: boolean;
  db: Database;
  elicitToken?: string | null;
  acl?: FolderAcl;
  /** THE-209: active workspace session for this caller. When set (by the transport context
   *  factory), each dispatch appends a tool_invocation record to that session's JSONL trace. */
  sessionId?: string;
  now?: () => number;
}

/** MCP 2025-11-25 icon metadata (a structural subset of the SDK's Icon), surfaced in tools/list +
 *  describe_capability (THE-278). Optional plumbing; no tool populates it yet. */
export interface ToolIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** Optional output schema (MUST be a Zod OBJECT) advertised as the tool's `outputSchema`
   *  (MCP 2025-11-25, THE-278). When set, conformant clients REQUIRE + validate structuredContent
   *  on a successful result, so the handler's success payload MUST always be an object matching it.
   *  Opt-in per tool; the server already emits structuredContent for object results. */
  outputSchema?: z.ZodType<O>;
  requiredScopes: string[];
  /** Free-form classification labels for tool-visibility scoping (THE-219):
   *  matched against toolVisibility.hiddenTags / disabledTags. */
  tags?: string[];
  /** Optional MCP 2025-11-25 icons metadata (THE-278). Boundary-only; never read by dispatch. */
  icons?: ToolIcon[];
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

/** THE-228: one dispatch outcome, as handed to the experiential episode bus. Carries the
 *  audit-row fields plus the raw parsed input; content policy (redact / cap / drop) belongs
 *  to the sink, never to the registry. */
export interface DispatchEpisode {
  ts: number;
  vaultId: string;
  tool: string;
  caller: string | null;
  sessionId: string | null;
  status: Status;
  errorCode: string | null;
  durationMs: number;
  resultSize: number;
  argsHash: string;
  /** Raw parsed input as received. */
  args: unknown;
}

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

/** One dispatch's coarse timing, reported to an onProfile sink (OBSIDIAN_TC_PROFILE). */
export interface DispatchProfile {
  tool: string;
  vaultId: string;
  total_ms: number;
  handler_ms: number;
}

// THE-294 — single-serialization contract. runDispatch stringifies a successful result once for
// the byte governor; the transport formatter (mcp/server.ts formatData) consumes that string via
// this memo instead of re-stringifying the same object. Entries are take-and-delete (consumed by
// exactly the request that produced them), and only non-null objects are memoized — primitives
// fall through to the formatter's own cheap stringify. If two concurrent dispatches ever return
// the SAME object reference, the later write wins; both stringify the identical reference, so
// the text is correct unless the object is mutated in between (no handler does this).
const serializedResults = new WeakMap<object, string>();

export function memoizeSerialized(data: unknown, json: string): void {
  if (data !== null && typeof data === "object") serializedResults.set(data as object, json);
}

export function takeSerialized(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const s = serializedResults.get(data as object);
  if (s !== undefined) serializedResults.delete(data as object);
  return s;
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
  /** THE-293: window (seconds) after which a crashed in-flight idempotency row may be
   *  reclaimed at dispatch. Default 60. */
  idempotencyReclaimSeconds?: number;
  /** Static tool-visibility scoping (THE-219). Optional: ALLOW_ALL when absent. */
  toolVisibility?: ToolVisibilityConfig;
  /** Profile sink (perf diagnostics). When set, each successful dispatch reports total vs
   *  handler time; absent by default, so there is no observable overhead. */
  onProfile?: (p: DispatchProfile) => void;
  /** THE-209 session tracer. When set, a dispatch whose ctx.sessionId is present appends a
   *  tool_invocation trace record to that session's JSONL (the transport wires the path). */
  sessionTracer?: (
    session: { vaultId: string; sessionId: string; caller: string | null },
    record: TraceRecord,
  ) => void;
  /** THE-295 per-vault ACL resolver. When the parsed input names a vault, dispatch swaps
   *  ctx.acl to that vault's ACL (root ACL = inherited default) so the readOnly gate and every
   *  handler-side enforcePathAcl run under the right vault's rules. */
  aclResolver?: (vaultId: string) => FolderAcl | undefined;
  /** THE-288 internal-error sink. When a handler throws a non-typed exception (a server bug),
   *  the client response is redacted to `{code:"internal"}`; this sink receives the real error +
   *  stack for operator diagnosis. Never wired to stdout (the MCP channel); best-effort. */
  onInternalError?: (tool: string, vaultId: string, err: unknown) => void;
  /** THE-228 episode capture. Called once per dispatch outcome (every dispatch, session or
   *  not) with the audit-row fields + raw parsed input; the experiential capture bus persists
   *  it. Best-effort by contract: sink failures are swallowed and never break dispatch. */
  onEpisode?: (e: DispatchEpisode) => void;
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
  private readonly idempotencyReclaimMs: number;
  private readonly toolVisibility: ToolVisibilityConfig;
  private readonly onProfile?: (p: DispatchProfile) => void;
  private readonly sessionTracer?: RegistryOptions["sessionTracer"];
  private readonly onInternalError?: RegistryOptions["onInternalError"];
  private readonly aclResolver?: RegistryOptions["aclResolver"];
  private readonly onEpisode?: RegistryOptions["onEpisode"];

  constructor(opts: RegistryOptions = {}) {
    this.maxResponseBytes = opts.maxResponseBytes ?? 1_000_000;
    this.verifyElicit = opts.verifyElicit;
    this.metrics = opts.metrics;
    this.tracer = opts.tracer;
    this.emit = opts.emit;
    this.rateLimiter = opts.rateLimiter;
    this.idempotencyTtlMs = (opts.idempotencyTtlSeconds ?? 86400) * 1000;
    this.idempotencyReclaimMs = (opts.idempotencyReclaimSeconds ?? 60) * 1000;
    this.toolVisibility = opts.toolVisibility ?? ALLOW_ALL;
    this.onProfile = opts.onProfile;
    this.sessionTracer = opts.sessionTracer;
    this.onInternalError = opts.onInternalError;
    this.aclResolver = opts.aclResolver;
    this.onEpisode = opts.onEpisode;
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
      cachedPrepare(
        db,
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
    return cachedPrepare(
      db,
      "SELECT tool_name, args_hash, started_at, completed_at, result, result_size, expires_at FROM idempotency_keys WHERE vault_id = ? AND key = ?",
    ).get(vaultId, key) as
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
    cachedPrepare(
      db,
      "UPDATE idempotency_keys SET completed_at = ?, result = ?, result_size = ? WHERE vault_id = ? AND key = ?",
    ).run(nowMs, json, size, vaultId, key);
  }

  private deleteIdempotency(db: Database, vaultId: string, key: string): void {
    cachedPrepare(db, "DELETE FROM idempotency_keys WHERE vault_id = ? AND key = ?").run(
      vaultId,
      key,
    );
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
      // THE-209: mirror the audit row into the active session's JSONL trace, if any.
      if (ctx.sessionId && this.sessionTracer) {
        try {
          this.sessionTracer(
            { vaultId: ctx.vaultId, sessionId: ctx.sessionId, caller: ctx.caller },
            {
              ts: Date.now(),
              type: "tool_invocation",
              tool: name,
              caller: ctx.caller,
              duration_ms: durationMs,
              args_hash: hash,
              result_size: resultSize,
              status,
              ...(code ? { error_code: code } : {}),
            },
          );
        } catch {
          /* tracing must never break dispatch */
        }
      }
      // THE-228: hand the same outcome to the experiential episode bus — every dispatch,
      // session or not. The bus owns content policy (redaction / caps / off) + persistence.
      if (this.onEpisode) {
        try {
          this.onEpisode({
            ts: Date.now(),
            vaultId: ctx.vaultId,
            tool: name,
            caller: ctx.caller,
            sessionId: ctx.sessionId ?? null,
            status,
            errorCode: code ?? null,
            durationMs,
            resultSize,
            argsHash: hash,
            args: rawInput,
          });
        } catch {
          /* capture must never break dispatch */
        }
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

      // Vault-binding guard (THE-267). A vault-bound caller (an HTTP token) may act only on its
      // own vault: the ~90 vault tools resolve a caller-supplied `vault` arg against ANY configured
      // vault under the single global ACL, so without this a token reaches every vault. resources/read
      // already enforces the same invariant. Fires only when a `vault` arg is present, so the execute
      // family (no vault arg) and vault-omitting calls are unaffected; trusted stdio is unbound.
      if (ctx.vaultBound === true) {
        const requested = (parsed.data as { vault?: unknown } | null)?.vault;
        if (typeof requested === "string" && requested !== ctx.vaultId)
          throw new ObsidianTcError("forbidden", "vault is not the caller's bound vault", {
            vault: requested,
            bound_vault: ctx.vaultId,
          });
      }

      // THE-295: per-vault ACL. When the parsed input names a vault, the remainder of this
      // dispatch (the readOnly gate below + every enforcePathAcl in the handler) runs under
      // THAT vault's ACL — the root ACL is the inherited default. Runs AFTER the THE-267
      // vault-binding guard, so a bound caller cannot reach another vault's ACL. The advertised
      // tool surface (listVisible) deliberately keeps the caller's default ACL; enforcement is
      // per-vault here at dispatch.
      if (this.aclResolver) {
        const requestedVault = (parsed.data as { vault?: unknown } | null)?.vault;
        if (typeof requestedVault === "string") {
          const vaultAcl = this.aclResolver(requestedVault);
          // Property mutation (not param reassignment): ctx objects are per-dispatch.
          if (vaultAcl) (ctx as { acl?: typeof vaultAcl }).acl = vaultAcl;
        }
      }

      const mutating = def.destructive === true || def.requiredScopes.some(isMutatingScope);
      if (mutating && ctx.acl?.readOnly)
        throw new ObsidianTcError("forbidden", "vault is read-only (acl.readOnly)");

      // Tool-specific precondition gate (D5). After scope/ACL, before HITL, so a
      // rejected precheck never consumes the single-use elicit token.
      if (def.precheck) await def.precheck(parsed.data, ctx);

      // Idempotency gate (D3). A keyed call claims a row in idempotency_keys; a
      // replay returns the cached result without re-running the handler. Runs after
      // auth/scope/ACL/precheck but BEFORE throttle/HITL: the lock must be claimed
      // atomically before the single-use elicit token is consumed, so two concurrent
      // identical requests can't each consume the token (TOCTOU). Authorization
      // (auth/scope/ACL) still runs before this gate, so it stays authoritative on replays.
      idemKey = extractIdempotencyKey(parsed.data);
      if (idemKey) {
        if (
          this.tryClaimIdempotency(ctx.db, ctx.vaultId, idemKey, name, hash, now()) === "claimed"
        ) {
          idemClaimed = true;
        } else {
          let row = this.readIdempotency(ctx.db, ctx.vaultId, idemKey);
          // Reclaim an expired or crashed (in-flight past the configured reclaim window) row,
          // then retry once (idempotencyReclaimSeconds, THE-293).
          if (
            row &&
            (row.expires_at <= now() ||
              (row.completed_at == null && row.started_at + this.idempotencyReclaimMs <= now()))
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
                memoizeSerialized(cached, cachedStr);
                const resultSize = row.result_size ?? Buffer.byteLength(cachedStr, "utf8");
                const duration = Math.max(0, now() - start);
                audit("ok", duration, resultSize);
                this.meter((m) =>
                  m.observeToolCall(ctx.vaultId, name, "ok", duration / 1000, resultSize),
                );
                this.meter((m) => m.incIdempotencyHit(ctx.vaultId, name));
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

      // Dispatch-wide rate-limit policy gate (THE-210, G2.4 §Rate limits). Per
      // (caller_hash, scope_class, vault); an unknown scope class is unlimited. Runs
      // BEFORE HITL so a throttled call never consumes the single-use elicit token (a
      // backed-off retry can reuse the same confirmation), and so the limiter covers every
      // dispatch that reaches this gate, including calls that will fail HITL, not just the
      // ones that clear it. Completed idempotent replays returned from the cache above, so
      // they are intentionally not re-counted here: the original call already drew down the
      // bucket. A throttled check does not draw down the bucket, so rejecting here costs no budget.
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

      // HITL gate. A destructive/HITL-floored tool requires a valid single-use elicit
      // token; verifyElicit consumes it (UPDATE ... WHERE consumed_at IS NULL). Runs after
      // the throttle gate (so a rate-limited call doesn't burn the confirmation) and last
      // before the handler (so the token is spent only once the call is cleared to execute).
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

      const handlerStart = now();
      const out = await def.handler(parsed.data, ctx);
      const handlerMs = Math.max(0, now() - handlerStart);
      const json = JSON.stringify(out ?? null);
      const resultSize = Buffer.byteLength(json, "utf8");
      const duration = Math.max(0, now() - start);

      if (resultSize > this.maxResponseBytes) {
        if (idemClaimed && idemKey) {
          this.meter((m) => m.incIdempotencyCacheSkipped(ctx.vaultId, name));
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
      try {
        this.onProfile?.({
          tool: name,
          vaultId: ctx.vaultId,
          total_ms: duration,
          handler_ms: handlerMs,
        });
      } catch {
        /* profile sink must never block tool execution */
      }
      memoizeSerialized(out, json);
      return { ok: true, data: out, meta: { duration_ms: duration, result_size: resultSize } };
    } catch (e) {
      if (idemClaimed && idemKey) {
        try {
          this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
        } catch {
          /* cleanup best-effort; must not mask the original error */
        }
      }
      if (!(e instanceof ObsidianTcError)) {
        // THE-288: a non-typed throw is a server bug. Route the real error + stack to the
        // operator sink for diagnosis; the client response below stays the redacted `internal`.
        try {
          this.onInternalError?.(name, ctx.vaultId, e);
        } catch {
          /* diagnostics sink must never mask the original failure */
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
