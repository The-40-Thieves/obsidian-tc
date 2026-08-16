import { type Span, SpanStatusCode } from "@opentelemetry/api";
import type {
  MorgianaEventData,
  MorgianaEventType,
  ToolResult,
} from "@the-40-thieves/obsidian-tc-shared";
import { type AuditEvent, writeEvent } from "../../audit";
import { redactSecrets } from "../../experiential/redact";
import type { MetricsRecorder, ToolCallStatus } from "../../metrics/registry";
import { SPAN_ATTR } from "../../otel/attrs";
import { callerHash } from "../../throttle";
import type { ToolStore } from "./tool-store";
import type { CallerContext, EpisodeKind, RegistryOptions, Status } from "./types";

// WP4.2: the observability sinks pulled out of ToolRegistry, with IDENTICAL inputs and error
// redaction to what registry.ts had. Every one of these is best-effort by contract — a metrics,
// MORGIANA, session-trace, episode, or audit-sink failure must never break dispatch (G2.4). The
// try/catch boundaries below are that contract; they are unchanged from the pre-extraction code,
// not reworked. ToolRegistry still owns ONE instance of this class (composition, not a port — map
// constraint 6) and its own `meter`/`relay`/`relayCompletion`/`emitCompletion`/`recordOutcome`
// methods are now one-line delegations to it, so the ~25 call sites inside runDispatch/
// dispatchResource (which do not move this slice) are untouched.

/** Map a terminal error code to the G2.4 tool-call status label (ok | denied | error). */
export function callStatusForError(code: string): ToolCallStatus {
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
export function annotateSpanResult(span: Span, result: ToolResult): void {
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

export interface DispatchObservabilityDeps {
  /** Only used to resolve a tool's requiredScopes for the MORGIANA payload (morgianaData) — the
   *  same ToolStore instance ToolRegistry already owns, passed in rather than duplicated. This is
   *  a sibling leaf import, not a cycle back to registry.ts. */
  toolStore: ToolStore;
  metrics?: MetricsRecorder;
  emit?: (vaultId: string, type: MorgianaEventType, data: Partial<MorgianaEventData>) => void;
  sessionTracer?: RegistryOptions["sessionTracer"];
  /** THE-736: capture arguments onto the trace. Off unless the operator opts in. */
  traceContent?: boolean;
  maxTraceArgsBytes?: number;
  onAuditFailure?: RegistryOptions["onAuditFailure"];
  onEpisode?: RegistryOptions["onEpisode"];
}

/**
 * THE-736 — the arguments half of a trace record, or nothing at all.
 *
 * Returns an EMPTY object when capture is off, so the field is absent rather than null. Absent
 * means "not captured"; a null would be indistinguishable from "captured, and it was null" — the
 * failure-encoded-as-a-valid-value shape this repo keeps finding.
 *
 * Redaction is not optional and is not this function's invention: it reuses `redactSecrets`, the
 * same scanner the episode capture bus runs, so a pattern added for one surface protects both.
 * The cap is applied AFTER redaction, so truncation can never cut a secret in half and leave the
 * prefix readable.
 */
/** Ceiling on the text handed to the secret scanner. Orders of magnitude above the 4 KiB arg
 *  cap, so it only ever bites on pathological input. */
const REDACT_SCAN_CEILING = 64 * 1024;

export function captureArgs(
  rawInput: unknown,
  enabled: boolean,
  maxBytes: number,
): { args?: string; args_scan?: string } {
  if (!enabled) return {};
  const full = JSON.stringify(rawInput ?? null);
  // Bound what the scanner sees, independently of any one pattern. Redaction runs BEFORE the size
  // cap on purpose (so a cut cannot split a secret), which means the scanner would otherwise face
  // unbounded caller-controlled text on the dispatch path. This is defence in depth against the
  // whole regex set rather than one fixed pattern, and it is lossless in practice: the ceiling is
  // far above `maxBytes`, so everything discarded here would have been truncated away anyway —
  // it can never drop a secret INTO the output, only out of it.
  const raw = full.length > REDACT_SCAN_CEILING ? full.slice(0, REDACT_SCAN_CEILING) : full;
  const { text, redactions } = redactSecrets(raw);
  const truncated = text.length > maxBytes;
  const args = truncated ? `${text.slice(0, maxBytes)}…[truncated]` : text;
  const scan = truncated ? "truncated" : redactions > 0 ? `redacted:${redactions}` : "clean";
  return { args, args_scan: scan };
}

export class DispatchObservability {
  private readonly toolStore: ToolStore;
  private readonly metrics?: MetricsRecorder;
  private readonly emit?: (
    vaultId: string,
    type: MorgianaEventType,
    data: Partial<MorgianaEventData>,
  ) => void;
  private readonly sessionTracer?: RegistryOptions["sessionTracer"];
  /** THE-736: `sessions.traceContent`. Default false — capture is opt-in. */
  private readonly traceContent: boolean;
  private readonly maxTraceArgsBytes: number;
  private readonly onAuditFailure?: RegistryOptions["onAuditFailure"];
  private readonly onEpisode?: RegistryOptions["onEpisode"];

  constructor(deps: DispatchObservabilityDeps) {
    this.toolStore = deps.toolStore;
    this.metrics = deps.metrics;
    this.emit = deps.emit;
    this.sessionTracer = deps.sessionTracer;
    this.traceContent = deps.traceContent ?? false;
    this.maxTraceArgsBytes = deps.maxTraceArgsBytes ?? 4096;
    this.onAuditFailure = deps.onAuditFailure;
    this.onEpisode = deps.onEpisode;
  }

  /** Record into the Prometheus recorder; a metrics error must never break dispatch (G2.4). */
  meter(fn: (m: MetricsRecorder) => void): void {
    const m = this.metrics;
    if (!m) return;
    try {
      fn(m);
    } catch {
      /* observability must never block tool execution */
    }
  }

  /** Emit one MORGIANA CloudEvent; a sink error must never break dispatch (G2.4 fail-soft). */
  relay(vaultId: string, type: MorgianaEventType, data: Partial<MorgianaEventData>): void {
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
      scopes_required: this.toolStore.get(name)?.requiredScopes ?? [],
      status: result.ok ? "ok" : callStatusForError(result.error.code),
      duration_ms: result.meta.duration_ms,
      // THE-288 hardening: emit a one-way fingerprint, never the raw single-use HITL token.
      elicit_token: ctx.elicitToken ? callerHash(ctx.elicitToken) : null,
      result_size: result.meta.result_size,
      overflow_bytes: result.meta.overflow_bytes ?? null,
      error: result.ok ? null : { code: result.error.code, message: result.error.message },
    };
  }

  /**
   * THE-514 item 1: the MORGIANA completion-event fan-out for a terminal call outcome — always
   * tc.tool.call.completed, plus the specific signal for the error code (if any). This used to be
   * two copies: emitCompletion's switch (below) for tool dispatch, and a REDUCED copy inside
   * dispatchResource's `emit` closure that fired only tc.tool.call.completed and never the
   * per-error-code signal — so a resource read denied by path ACL never relayed tc.acl.denied,
   * a resource over MAX_RESOURCE_BYTES never relayed tc.governor.overflow, etc., for the exact
   * codes tool dispatch already signals on. Deliberate decision: resources gain the richer
   * behavior (relay through this shared method) rather than tools losing it, because this is
   * strictly more information to the same MORGIANA consumer and changes no existing tool
   * behavior — dispatchResource's caller-visible contract (throw/return) is untouched.
   */
  relayCompletion(
    vaultId: string,
    name: string,
    status: ToolCallStatus,
    code: string | undefined,
    data: Partial<MorgianaEventData>,
  ): void {
    this.relay(vaultId, "tc.tool.call.completed", data);
    if (status === "ok") {
      if (name === "reset_vault_cache") this.relay(vaultId, "tc.vault.cache_reset", data);
      return;
    }
    switch (code) {
      case "forbidden":
      case "acl_denied":
        this.relay(vaultId, "tc.acl.denied", data);
        break;
      case "overflow":
        this.relay(vaultId, "tc.governor.overflow", data);
        break;
      case "elicit_required":
        this.relay(vaultId, "tc.elicit.requested", data);
        break;
      case "throttled":
        this.relay(vaultId, "tc.rate_limit.hit", data);
        break;
    }
  }

  /** Per-call MORGIANA events for a completed tool dispatch — see relayCompletion. */
  emitCompletion(name: string, ctx: CallerContext, result: ToolResult): void {
    if (!this.emit) return;
    const data = this.morgianaData(name, ctx, result);
    const status: ToolCallStatus = result.ok ? "ok" : callStatusForError(result.error.code);
    this.relayCompletion(
      ctx.vaultId,
      name,
      status,
      result.ok ? undefined : result.error.code,
      data,
    );
  }

  /**
   * THE-415: record ONE governed outcome - audit row + session trace + episode bus.
   *  Shared by tool dispatch and by dispatchResource, so the resources/* surface cannot
   *  drift from tools/* on audit. Fail-open throughout: observability must never break
   *  the call.
   */
  recordOutcome(
    ctx: CallerContext,
    name: string,
    /** THE-839: which KIND of operation this was, decided by the caller. REQUIRED and positional
     *  rather than defaulted, for the same reason `CredentialSlot` is required on PostJsonOptions:
     *  a default would let a future third entry point silently inherit `tool_call`, which is
     *  exactly the bug this parameter exists to close. Both call sites must say what they are. */
    kind: EpisodeKind,
    hash: string,
    rawInput: unknown,
    status: Status,
    durationMs: number,
    resultSize: number,
    code?: string,
  ): void {
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
      // Audit stays fail-open — it must never break dispatch. But a silent failure
      // (locked DB, disk full, migration drift) makes the security-audit trail lossy
      // with no signal at all, so surface it as a metric. meter() is itself guarded,
      // so this cannot throw back out of the catch. THE-457: also notify the health sink so an
      // operator watching server_health (not metrics) sees the audit trail going lossy.
      this.meter((m) => m.incAuditWriteFailed(ctx.vaultId, name));
      try {
        this.onAuditFailure?.(name, ctx.vaultId);
      } catch {
        /* health sink must never break dispatch */
      }
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
            // THE-736: the arguments, only when the operator turned capture on. Same policy as
            // experiential `captureContent` — secret-scanned, size-capped — and deliberately the
            // same helper, so the two capture surfaces cannot drift on what counts as a secret.
            ...captureArgs(rawInput, this.traceContent, this.maxTraceArgsBytes),
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
          kind,
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
  }
}
