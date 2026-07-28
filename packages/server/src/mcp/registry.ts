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
  type VaultKind,
} from "@the-40-thieves/obsidian-tc-shared";
import type { z } from "zod";
import type { FolderAcl } from "../acl";
import { type AuditEvent, writeEvent } from "../audit";
import { cachedPrepare, type Database } from "../db/types";
import { type ElicitRequestState, hitlSatisfiedByState } from "../elicit-request-state";
import { argsHash } from "../hash";
import type { MetricsRecorder, ToolCallStatus } from "../metrics/registry";
import { SPAN_ATTR } from "../otel/attrs";
import { type TraceCarrier, withTraceCarrier } from "../otel/propagation";
import { callerHash, type RateLimiter } from "../throttle";
import { CROSS_NOTE_REWRITE_TOOLS, runAudited } from "../vault/acl-audit";
import { type AclOp, enforcePathAcl } from "../vault/acl-path";
import type { TraceRecord } from "../workspace/sessions";
import type { ClientInfo } from "./client-info";
import { ALLOW_ALL, isDisabled, isListed, type VisibilityCaller } from "./visibility";

/** #13: the idempotency claim's lifecycle states, as a union so `row.state === "..."`
 *  comparisons in dispatch are compiler-checked against typos. The DB column itself is a plain
 *  string; readIdempotency casts it to this type at the read site. */
type IdempotencyState = "in_flight" | "effect_committed" | "completed" | "indeterminate";

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
  /** THE-583: a transport-VERIFIED 2026-era HITL confirmation (HMAC+TTL already checked); the
   *  gate still binds it to this call. Absent for 2025 callers, who use `elicitToken`. */
  elicitState?: ElicitRequestState;
  acl?: FolderAcl;
  /** THE-209: active workspace session for this caller. When set (by the transport context
   *  factory), each dispatch appends a tool_invocation record to that session's JSONL trace. */
  sessionId?: string;
  /** THE-572: a multi-step handler's mid-execution "my first durable effect is about to land"
   *  signal. #13 sets the `effect_committed` marker only when the WHOLE handler returns, so a
   *  handler that commits effect #1 and then does more fallible work leaves a real window: a
   *  throw before the return deletes the claim and a retry double-applies. Calling this
   *  IMMEDIATELY BEFORE the first durable effect moves the marker to the true first-effect
   *  point, so any later fault resolves to a durable `indeterminate_outcome` instead of a
   *  re-run. Write-ahead on purpose: marking before the effect can only over-report
   *  (a caller told to verify state when nothing applied), never under-report (a silent
   *  double-apply). Where the first effect is itself a write on `ctx.db`, call this INSIDE
   *  the same transaction as that write so a rolled-back effect leaves the claim legitimately
   *  re-runnable and the over-report does not happen at all.
   *
   *  Idempotent, and absent (undefined) when the call carries no idempotency key — always
   *  invoke as `ctx.markEffectCommitted?.()`. */
  markEffectCommitted?: () => void;
  now?: () => number;
  /** THE-514: the transport's per-request AbortSignal (MCP SDK `extra.signal`, an HTTP request's
   *  abort, or a stdio caller's own cancellation), threaded in by the context factory. runDispatch
   *  checks it at a few stage boundaries and immediately before the handler runs, so a cancelled
   *  call stops promptly instead of running a handler nobody is waiting on. Absent for any caller
   *  that does not supply one (every existing caller today) — every check is then a no-op, so
   *  behavior is unchanged. Deliberately NOT observed by tool handlers in this change: honoring it
   *  mid-handler is a per-tool behavior change left to a follow-up. */
  signal?: AbortSignal;
  /** SEP-414: W3C trace context lifted from the request's MCP `_meta`, set by the transport's
   *  request handler. When present, dispatch's SERVER span is parented to the CALLER's span, so a
   *  trace that starts in a host application continues through this server instead of ending at the
   *  edge and starting a second, unrelated tree. Absent for any caller that sends none — the span
   *  is then a root exactly as before. */
  traceCarrier?: TraceCarrier;
  /** THE-627: which client software made this call, lifted from the request's MCP `_meta`. Absent
   *  for every caller that sends none — which is all of them under the current spec, so absent is
   *  the normal value. Consumed by start_session to stamp the session row. */
  clientInfo?: ClientInfo;
}

/**
 * THE-514 item 1: the scope-requirement check `runDispatch`'s own scope gate (below) and
 * `resources.ts`'s readResource each wrote independently — `if (!grantsAll(...)) throw
 * forbidden(...)`. Unlike the vault-binding guard (see the AUTHORITATIVE NOTE further down),
 * this one had no semantic divergence to preserve: same primitive (`grantsAll`), same error code,
 * same shape of `details`. It had already started to drift anyway — resources.ts's version omitted
 * `details.required`, which the "forbidden" error's own documented recovery hint
 * (`shared/src/errors.ts`) promises callers can read. One function now backs both call sites, so
 * a future change to how a missing scope is reported cannot silently apply to only one surface.
 */
export function assertScopesGranted(
  ctx: Pick<CallerContext, "grantedScopes">,
  requiredScopes: string[],
  message: string,
): void {
  if (!grantsAll(ctx.grantedScopes, requiredScopes)) {
    throw err.forbidden(message, { required: requiredScopes });
  }
}

/** MCP 2025-11-25 icon metadata (a structural subset of the SDK's Icon), surfaced in tools/list +
 *  describe_capability (THE-278). Optional plumbing; no tool populates it yet. */
export interface ToolIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

/** THE-513: the facade's domain-grouping ids — a closed set of 13, unchanged since the THE-577
 *  backfill made the (now-removed) facade domain map complete. Declared here, not in mcp/facade.ts,
 *  so `ToolDefinition.domain` can require one: domain membership is a fact about the capability
 *  itself, not a second hand-maintained catalog naming ~150 tools by string. mcp/facade.ts groups
 *  the caller-visible surface by this field; it no longer carries membership of its own. */
export const TOOL_DOMAINS = [
  "notes",
  "metadata",
  "links",
  "search",
  "vault",
  "attachments",
  "structured",
  "workspace",
  "automation",
  "git",
  "knowledge",
  "docs",
  "admin",
] as const;

export type ToolDomain = (typeof TOOL_DOMAINS)[number];

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  /** THE-583: runnable as a background TASK on `params.task`; opt-in. See mcp/tasks.ts. */
  taskAugmentable?: boolean;
  /** THE-513: which facade domain (see TOOL_DOMAINS) this capability groups under in "domain" mode.
   *  Optional here (the sink type) so fixtures unrelated to the facade — dispatch/throttle/HITL
   *  unit tests build bare ToolDefinition literals to exercise the pipeline — don't need to fabricate
   *  one; `domainTools()` falls back to "other" for a tool with none. It is REQUIRED on `ToolSpec`
   *  (m1/define.ts), which is what every real definition goes through, so a production tool cannot
   *  ship without one — the failure mode that let the old hand-kept facade map fall 38 tools behind
   *  in THE-577 is now a type error at the definition site, not a silent "other" bucket. */
  domain?: ToolDomain;
  /** THE-513 Part 2: the input field name that carries this tool's target vault id, when it has
   *  one — default "vault", the name every tool used before this field existed. The four
   *  `vaultArgOf` call sites below (vault-binding, per-vault ACL swap, vault-kind gate, central
   *  pathAcl) read THIS instead of hardcoding "vault", so a tool naming the field anything else
   *  is still bound/ACL-swapped/gated correctly. Before this field, a capability naming its vault
   *  argument anything other than "vault" silently escaped all four of those checks — they simply
   *  saw `undefined` and skipped. Optional here (the sink type, same reasoning as `domain`); every
   *  MUTATING tool whose schema has a vault-shaped field MUST declare it via `vault-arg-coverage
   *  .test.ts`, mirroring `acl-extraction-coverage.test.ts`'s mutating derivation. */
  vaultArg?: string;
  /** THE-513 Part 2: declares that this tool's input schema exposes a whole-operation idempotency
   *  key recognized by `extractIdempotencyKey` (top-level `idempotency_key` / `bulk_idempotency_key`,
   *  or nested `options.idempotency_key`) — never a per-item `items[].idempotency_key`. Before this
   *  field, extractIdempotencyKey sniffed the input shape at runtime for every one of the ~150
   *  tools and nothing declared which ones actually accept a key, so a capability that SHOULD be
   *  idempotent and isn't (or vice versa) went unnoticed. `idempotency-declaration-coverage.test.ts`
   *  cross-checks this against the schema in both directions: declared-but-schema-silent and
   *  schema-exposes-a-key-but-undeclared both fail. */
  acceptsIdempotencyKey?: boolean;
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
  /** THE-414: declarative folder-ACL path extraction. Returns the vault-relative paths this tool
   *  touches, tagged by op, so runDispatch enforces the folder ACL centrally (right before the
   *  handler) instead of trusting each handler to call enforcePathAcl. Handler-side calls stay as
   *  defense-in-depth. Every path-touching tool MUST declare this (or sit in the guarantee test's
   *  documented exemption set); a mutating tool with neither fails the acl-extraction-coverage
   *  guarantee test. Extractors must mirror the handler's own enforcePathAcl calls exactly (same
   *  ops, same paths, same conditionals) so central enforcement never denies a call the handler
   *  would have allowed. */
  pathAcl?: (input: I) => ReadonlyArray<{ op: AclOp; path: string }>;
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

/** THE-513 Part 2: the caller-supplied target vault id for this call, read from the tool's
 *  declared `vaultArg` field (defaulting to "vault", the name every tool used before this field
 *  existed) — the single place the four call sites below resolve it, instead of each hardcoding
 *  `.vault` on the parsed input. */
function vaultArgOf(def: ToolDefinition, data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[def.vaultArg ?? "vault"];
  return typeof v === "string" ? v : undefined;
}

/** THE-514: a stage-boundary cooperative-cancellation check. Throws the same modelled
 *  `ObsidianTcError` the rest of dispatch throws (never a raw DOMException `AbortError`), so an
 *  abort surfaces through the normal catch/audit/metrics path below rather than as an unhandled
 *  rejection or an opaque `internal` error. A no-op when `signal` is absent or not yet aborted —
 *  every existing caller (no signal) sees no behavior change. */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw err.aborted();
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
  /** THE-414 vault-root resolver. runDispatch uses it to resolve the filesystem root for the
   *  effective vault so central pathAcl enforcement can run the same symlink-canonical
   *  enforcePathAcl the handlers do. Wired from the VaultRegistry in cli.ts; when absent (unit
   *  tests that omit it) central enforcement is skipped and handler-side checks still apply. */
  rootResolver?: (vaultId: string) => string | undefined;
  /** THE-569 vault-kind resolver: the reverse of P1.5's read:docs gate. When wired, dispatch
   *  refuses any MUTATING call (destructive tools or a required scope in a mutating family) whose
   *  effective vault resolves to `docs` or `system` kind — a reserved docs/system corpus is
   *  read-only BY KIND, not just by token-provisioning convention. Read (non-mutating) calls on a
   *  docs/system vault stay allowed; this closes only the write/integrity direction. Absent (unit
   *  tests that omit it, or a registry built with no VaultRegistry) means no gating — a no-op. */
  vaultKindResolver?: (vaultId: string) => VaultKind | undefined;
  /** THE-288 internal-error sink. When a handler throws a non-typed exception (a server bug),
   *  the client response is redacted to `{code:"internal"}`; this sink receives the real error +
   *  stack for operator diagnosis. Never wired to stdout (the MCP channel); best-effort. */
  onInternalError?: (tool: string, vaultId: string, err: unknown) => void;
  /** THE-417 Phase 2: fired once per output-schema mismatch, in BOTH warn and strict mode. Carries
   *  only the tool name and vault — never the payload or the Zod issues, which would put note
   *  content into a metrics label. The `message` on the onInternalError line above is where a
   *  human-readable diagnosis lives. */
  onOutputSchemaDrift?: (tool: string, vaultId: string) => void;
  /** THE-457: called when the fail-open audit write throws (locked DB, disk full, migration drift).
   *  Already counted as a metric; this sink lets the composition root also surface it in server_health
   *  so an operator watching health (not metrics) sees the audit trail going lossy. Best-effort. */
  onAuditFailure?: (tool: string, vaultId: string) => void;
  /** THE-228 episode capture. Called once per dispatch outcome (every dispatch, session or
   *  not) with the audit-row fields + raw parsed input; the experiential capture bus persists
   *  it. Best-effort by contract: sink failures are swallowed and never break dispatch. */
  onEpisode?: (e: DispatchEpisode) => void;
  /** THE-457: when true, a handler payload that violates its advertised `outputSchema` is a hard,
   *  typed `internal_error` instead of a logged warning that still returns the malformed payload.
   *  Off by default (production stays warn-only for backward compatibility); enable it in dev/CI so
   *  output-schema drift fails a test rather than reaching a client that may reject it. */
  strictOutputSchema?: boolean;
}

/** THE-457 (audit #4): default strict output-schema validation ON in test/CI, so a handler whose
 *  payload drifts from its advertised outputSchema fails a test instead of shipping warn-only to a
 *  client. Vitest sets NODE_ENV=test, so the existing suite exercises every real handler under strict
 *  validation; OBSIDIAN_TC_STRICT_OUTPUT_SCHEMA=1 opts in elsewhere (a CI job, a local run). Production
 *  sets neither and stays warn-only for backward compatibility; an explicit strictOutputSchema wins. */
function strictOutputSchemaDefault(): boolean {
  return process.env.NODE_ENV === "test" || process.env.OBSIDIAN_TC_STRICT_OUTPUT_SCHEMA === "1";
}

export class ToolRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool registry; the handler input type is contravariant, so ToolDefinition<unknown, unknown> is not assignable from a specific ToolDefinition.
  private readonly tools = new Map<string, ToolDefinition<any, any>>();
  private readonly _maxResponseBytes: number;
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
  private readonly onOutputSchemaDrift?: RegistryOptions["onOutputSchemaDrift"];
  private readonly onAuditFailure?: RegistryOptions["onAuditFailure"];
  private readonly aclResolver?: RegistryOptions["aclResolver"];
  private readonly rootResolver?: RegistryOptions["rootResolver"];
  private readonly vaultKindResolver?: RegistryOptions["vaultKindResolver"];
  private readonly onEpisode?: RegistryOptions["onEpisode"];
  private readonly strictOutputSchema: boolean;

  /** THE-514 item 2: read-only access to the configured ceiling, so mcp/server.ts can pass it to
   *  resources.ts's readResource — the single source of truth this registry already enforces for
   *  tools, now reaching the resources surface too instead of that surface holding its own fixed
   *  copy of the same default. */
  get maxResponseBytes(): number {
    return this._maxResponseBytes;
  }

  constructor(opts: RegistryOptions = {}) {
    this._maxResponseBytes = opts.maxResponseBytes ?? 1_000_000;
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
    this.onOutputSchemaDrift = opts.onOutputSchemaDrift;
    this.onAuditFailure = opts.onAuditFailure;
    this.aclResolver = opts.aclResolver;
    this.rootResolver = opts.rootResolver;
    this.vaultKindResolver = opts.vaultKindResolver;
    this.onEpisode = opts.onEpisode;
    this.strictOutputSchema = opts.strictOutputSchema ?? strictOutputSchemaDefault();
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
  private relayCompletion(
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
  private emitCompletion(name: string, ctx: CallerContext, result: ToolResult): void {
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
        state: IdempotencyState;
      }
    | undefined {
    return cachedPrepare(
      db,
      "SELECT tool_name, args_hash, started_at, completed_at, result, result_size, expires_at, state FROM idempotency_keys WHERE vault_id = ? AND key = ?",
    ).get(vaultId, key) as
      | {
          tool_name: string;
          args_hash: string;
          started_at: number;
          completed_at: number | null;
          result: unknown;
          result_size: number | null;
          expires_at: number;
          state: IdempotencyState;
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
      "UPDATE idempotency_keys SET completed_at = ?, result = ?, result_size = ?, state = 'completed' WHERE vault_id = ? AND key = ?",
    ).run(nowMs, json, size, vaultId, key);
  }

  /** #13: durable marker set the instant the handler returns — the effect may now be committed.
   *  A crash after this leaves a durable 'effect_committed' row that reclaim honors (never re-runs). */
  private markEffectCommitted(db: Database, vaultId: string, key: string, _nowMs: number): void {
    cachedPrepare(
      db,
      "UPDATE idempotency_keys SET state = 'effect_committed' WHERE vault_id = ? AND key = ? AND completed_at IS NULL",
    ).run(vaultId, key);
  }

  /** #13: a post-effect fault finalizes the claim as indeterminate (never deletes it), so a retry
   *  returns indeterminate_outcome instead of re-executing. result_size stays NULL so the overflow
   *  re-check never fires; the state='indeterminate' branch answers first. */
  private finalizeIndeterminate(db: Database, vaultId: string, key: string, nowMs: number): void {
    cachedPrepare(
      db,
      "UPDATE idempotency_keys SET completed_at = ?, result = 'null', result_size = NULL, state = 'indeterminate' WHERE vault_id = ? AND key = ?",
    ).run(nowMs, vaultId, key);
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
  /** THE-415: record ONE governed outcome - audit row + session trace + episode bus.
   *  Shared by tool dispatch and by dispatchResource, so the resources/* surface cannot
   *  drift from tools/* on audit. Fail-open throughout: observability must never break
   *  the call. */
  private recordOutcome(
    ctx: CallerContext,
    name: string,
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
  }

  /**
   * THE-415: run an MCP *resource* operation under the same governance a tool call gets -
   * rate limit, audit, metrics, MORGIANA.
   *
   * resources/list and resources/read already enforce their own AUTHORIZATION inside
   * resources.ts (read:notes scope, vault binding, folder read-ACL, path containment);
   * that stays, and remains the security boundary. What they bypassed was GOVERNANCE: the
   * dispatch-wide limiter never saw them, so a read:notes caller could pull the whole
   * vault in a loop with no budget, and no audit row was written - leaving the security
   * audit trail with a hole shaped exactly like "read the vault".
   *
   * Deliberately NOT registered as a ToolDefinition: resources are a distinct MCP surface
   * and must not appear in tools/list or be reachable via tools/call.
   */
  async dispatchResource<T>(
    name: string,
    ctx: CallerContext,
    requiredScopes: string[],
    args: unknown,
    fn: () => T,
  ): Promise<T> {
    const now = ctx.now ?? Date.now;
    const start = now();
    const hash = argsHash(name, (args ?? {}) as Record<string, unknown>);
    const scopeClass = scopeClassOf(requiredScopes as never);

    // THE-514 item 1: status classification and the completion fan-out are now the exact
    // functions tool dispatch uses (callStatusForError, relayCompletion) instead of a hand-copied
    // reduced version — see relayCompletion's docstring for what that copy used to drop.
    const emit = (status: Status, durationMs: number, resultSize: number, code?: string) => {
      this.recordOutcome(ctx, name, hash, args, status, durationMs, resultSize, code);
      const callStatus: ToolCallStatus = status === "ok" ? "ok" : callStatusForError(code ?? "");
      this.meter((m) =>
        m.observeToolCall(ctx.vaultId, name, callStatus, durationMs / 1000, resultSize),
      );
      this.relayCompletion(ctx.vaultId, name, callStatus, code, {
        tool: name,
        caller_hash: callerHash(ctx.caller),
        scopes_required: requiredScopes,
        status: callStatus,
        duration_ms: durationMs,
        result_size: resultSize,
        elicit_token: null,
        error: code ? { code, message: code } : null,
      });
    };

    // The same rate-limit policy gate dispatch applies (THE-210): per (caller_hash,
    // scope_class, vault); an unknown scope class is unlimited. A throttled check draws
    // down no budget, so rejecting here costs the caller nothing. Unlike the old copy, this no
    // longer relays tc.rate_limit.hit by hand — emit(..., "throttled") below now does that
    // through relayCompletion's switch, the same path tool dispatch uses, so it fires exactly
    // once instead of the old double-emit this refactor would otherwise have introduced.
    if (this.rateLimiter) {
      const d = this.rateLimiter.check(callerHash(ctx.caller), scopeClass, ctx.vaultId, now());
      if (!d.ok) {
        this.meter((m) => m.incRateLimitHit(ctx.vaultId, scopeClass));
        emit("error", now() - start, 0, "throttled");
        throw err.throttled("rate limit exceeded", {
          scope_class: d.scopeClass,
          retry_after_seconds: d.retryAfterSeconds,
          current_burst: d.currentBurst,
        });
      }
    }

    try {
      const out = await fn();
      const size = takeSerialized(out)?.length ?? JSON.stringify(out ?? null).length;
      emit("ok", now() - start, size);
      return out;
    } catch (e) {
      const code = e instanceof ObsidianTcError ? e.code : "internal_error";
      emit("error", now() - start, 0, code);
      throw e;
    }
  }

  async dispatch(name: string, rawInput: unknown, ctx: CallerContext): Promise<ToolResult> {
    const tracer = this.tracer;
    if (!tracer) {
      const result = await this.runDispatch(name, rawInput, ctx);
      this.emitCompletion(name, ctx, result);
      return result;
    }
    // SEP-414: parent the SERVER span to the caller's trace when they sent one. withTraceCarrier is
    // a pass-through when they did not, so the no-carrier path is unchanged — and a malformed
    // carrier degrades to a root span rather than losing one.
    return withTraceCarrier(ctx.traceCarrier, () =>
      tracer.startActiveSpan(`obsidian_tc.${name}`, { kind: SpanKind.SERVER }, async (span) => {
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
      }),
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
    // #13: set true the instant the handler returns — after this, a fault is post-effect
    // (the effect may be durably committed) and the catch below must never delete the claim.
    let handlerReturned = false;
    // THE-572: set true when a multi-step handler signals its first durable effect via
    // ctx.markEffectCommitted() — i.e. BEFORE it returns. From that point the same rule as
    // handlerReturned applies: the catch must record indeterminate, never delete-and-re-run.
    let effectCommitted = false;
    // THE-573 #1: the ctx we installed markEffectCommitted on, so the finally can remove it. Kept
    // as its own handle rather than re-deriving from ctx, so cleanup only ever clears a callback
    // THIS dispatch installed.
    let installedMarker: { markEffectCommitted?: () => void } | undefined;

    const audit = (status: Status, durationMs: number, resultSize: number, code?: string) =>
      this.recordOutcome(ctx, name, hash, rawInput, status, durationMs, resultSize, code);

    // #13: a retry against a row left `indeterminate` (post-effect fault) or orphaned
    // `effect_committed` (crash after effect) must never re-run the handler — it gets a definite
    // "may have applied" answer instead, so the caller can verify state before deciding to retry.
    const indeterminateReplay = (key: string) => {
      const duration = Math.max(0, now() - start);
      const e = new ObsidianTcError(
        "indeterminate_outcome",
        "a prior attempt with this idempotency key may have applied its effect but did not record a result; verify state before retrying",
        { key },
      );
      audit("error", duration, 0, e.code);
      this.meter((m) => {
        m.incIdempotencyHit(ctx.vaultId, name);
        m.observeToolCall(ctx.vaultId, name, "error", duration / 1000, 0);
      });
      return {
        ok: false as const,
        error: e.toJSON(),
        meta: { duration_ms: duration, result_size: 0 },
      };
    };

    try {
      // THE-514: an already-cancelled call never even resolves the tool, let alone claims an
      // idempotency slot or spends an elicit token.
      checkAborted(ctx.signal);
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

      assertScopesGranted(ctx, def.requiredScopes, "missing required scope(s)");

      // Vault-binding guard (THE-267). A vault-bound caller (an HTTP token) may act only on its
      // own vault: the ~90 vault tools resolve a caller-supplied `vault` arg against ANY configured
      // vault under the single global ACL, so without this a token reaches every vault. resources/read
      // already enforces the same invariant. Fires only when a `vault` arg is present, so the execute
      // family (no vault arg) and vault-omitting calls are unaffected; trusted stdio is unbound.
      //
      // THE-514 item 2 — AUTHORITATIVE NOTE on the one place this guard's condition differs from
      // resources.ts's readResource (its `if (vaultId !== ctx.vaultId)` check, which points back
      // here): this check is CONDITIONAL on `ctx.vaultBound === true`, so a trusted stdio caller
      // (vaultBound left unset) may still name any configured vault. readResource's equivalent
      // check is UNCONDITIONAL — it refuses `vaultId !== ctx.vaultId` regardless of vaultBound, so
      // even a trusted stdio caller reading a resource is pinned to its own vault.
      //
      // Same concern (don't let a caller reach a vault it isn't bound to), two behaviours, and this
      // is a DELIBERATE, EVALUATED divergence, not an oversight:
      //   - Tools stay conditional because trusted stdio operators routinely address every
      //     configured vault by name through the `vault` argument (prefetch, admin tools, multi-vault
      //     workflows) — that is the documented meaning of "trusted": no HTTP token, no vaultBound.
      //   - resources/read stays unconditional because listResources only ever emits URIs for
      //     ctx.vaultId (mcp/resources.ts's listResources) — there is no legitimate reason for ANY caller,
      //     trusted or not, to construct a foreign-vault resource URI by hand, so the narrower rule
      //     costs a trusted caller nothing while closing off a hand-crafted URI as an attack surface.
      // The divergence is currently in the SAFE direction (resources is the stricter of the two). If
      // this is ever revisited, that is a security-semantics decision — evaluate it explicitly rather
      // than "fixing" one side to match the other; see the parity gate in
      // dispatch-parity.test.ts ("vault-binding: documented divergence, asserted as such"), which
      // asserts this documented state rather than sameness.
      if (ctx.vaultBound === true) {
        const requested = vaultArgOf(def, parsed.data);
        if (requested !== undefined && requested !== ctx.vaultId)
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
        const requestedVault = vaultArgOf(def, parsed.data);
        if (requestedVault !== undefined) {
          const vaultAcl = this.aclResolver(requestedVault);
          // Property mutation (not param reassignment): ctx objects are per-dispatch.
          if (vaultAcl) (ctx as { acl?: typeof vaultAcl }).acl = vaultAcl;
        }
      }

      const mutating = def.destructive === true || def.requiredScopes.some(isMutatingScope);
      if (mutating && ctx.acl?.readOnly)
        throw new ObsidianTcError("forbidden", "vault is read-only (acl.readOnly)");

      // THE-569: reverse vault-kind gate. P1.5 closed the READ direction (the read:docs tools
      // refuse any vault whose kind isn't `docs`); this closes the WRITE/integrity direction — a
      // mutating call must not be able to reach a `docs`- or `system`-kind vault just because it
      // named that vault's id. Runs on the same effective vault (input.vault, falling back to
      // ctx.vaultId) the pathAcl stage below resolves, so it agrees with what actually gets
      // touched. A no-op when no vaultKindResolver is wired (a registry built with no
      // VaultRegistry, or a unit test that omits it).
      if (this.vaultKindResolver && mutating) {
        const effVault = vaultArgOf(def, parsed.data) ?? ctx.vaultId;
        const kind = this.vaultKindResolver(effVault);
        if (kind === "docs" || kind === "system")
          throw err.forbidden(`${name} cannot mutate a ${kind}-kind vault`, {
            vault: effVault,
            kind,
          });
      }

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
              (row.state === "in_flight" &&
                row.completed_at == null &&
                row.started_at + this.idempotencyReclaimMs <= now()))
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
            if (row.state === "indeterminate") return indeterminateReplay(idemKey);
            if (row.state === "effect_committed") return indeterminateReplay(idemKey);
            if (row.completed_at != null) {
              // Terminal-overflow replay: the original call committed its side effect but its response
              // exceeded the byte budget, so the claim was finalized with the real over-limit size and
              // no payload. Replay the SAME overflow error rather than re-executing or returning an
              // absent/oversized payload. A normal success always finalizes with size <= the budget,
              // so this never fires on a legitimate cached result.
              if (row.result_size != null && row.result_size > this._maxResponseBytes) {
                // Hoist the narrowed size into a const so it stays `number` inside the meter closure
                // (TS drops the `!= null` narrowing on a property access captured by a later-called fn).
                const overSize = row.result_size;
                const duration = Math.max(0, now() - start);
                const e = new ObsidianTcError("overflow", "response exceeds byte budget", {
                  result_size: overSize,
                  limit: this._maxResponseBytes,
                });
                audit("error", duration, overSize, e.code);
                this.meter((m) => {
                  m.incIdempotencyHit(ctx.vaultId, name);
                  m.observeToolCall(ctx.vaultId, name, "error", duration / 1000, overSize);
                });
                return {
                  ok: false,
                  error: e.toJSON(),
                  meta: {
                    duration_ms: duration,
                    result_size: overSize,
                    overflow_bytes: overSize - this._maxResponseBytes,
                  },
                };
              }
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

      // THE-514: a boundary mid-pipeline. If idemClaimed is true here, the claim was JUST taken
      // above and the handler has not run — the catch below sees handlerReturned/effectCommitted
      // both false and deletes the claim, so a cancelled call never strands a claim that blocks a
      // legitimate retry.
      checkAborted(ctx.signal);

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
          (!!ctx.elicitToken &&
            !!this.verifyElicit &&
            this.verifyElicit(ctx.elicitToken, hash, ctx)) ||
          // THE-583 2026-era path: transport-authenticated state, bound to THIS call. The decision
          // lives in elicit-request-state.ts (hitlSatisfiedByState) so it is testable without a
          // registry; this file's biome line cap was raised 1310 -> 1325 for the wiring rather than
          // shaving the reasoning around it, matching what THE-610 did for the sweep.
          hitlSatisfiedByState(ctx.elicitState, {
            tool: name,
            argsHash: hash,
            vaultId: ctx.vaultId,
            caller: ctx.caller,
          });
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
          // THE-288 hardening: fingerprint, not the raw token (see morgianaData).
          elicit_token: ctx.elicitToken ? callerHash(ctx.elicitToken) : null,
        });
      }

      // THE-414: central folder-ACL enforcement. Extract the vault-relative paths this call
      // touches (declared per tool via def.pathAcl) and enforce the per-op ACL HERE, right before
      // the handler — so containment no longer depends on every handler remembering to call
      // enforcePathAcl (the handler-side calls remain as defense-in-depth). Placed after the HITL
      // gate to mirror exactly where handler-side enforcement ran, so ordering/behavior is
      // unchanged. Uses the same symlink-canonical enforcePathAcl + the (already per-vault-swapped)
      // ctx.acl; the root is the effective vault's. Skipped when no root resolver is wired.
      // Central folder-ACL stage + handler, wrapped in the (default-off) ACL-audit frame so a
      // dev/test run can verify each pathAcl extractor mirrors the handler's real fs usage (#280).
      // THE-572: hand a multi-step handler the mid-execution effect-committed signal, so it can
      // move the #13 marker from "handler returned" to its own FIRST durable effect. Installed
      // here — after every gate that can still reject-and-release the claim (throttle, HITL), so
      // the callback never outlives the claim it points at — and only when this dispatch owns
      // that claim; a keyless call leaves it undefined, which is why every handler-side call
      // site is `ctx.markEffectCommitted?.()`. Property mutation on a per-dispatch ctx, same as
      // the per-vault ACL swap above. Idempotent: the UPDATE is a plain state set guarded on
      // `completed_at IS NULL`, so signalling twice — or signalling and then returning normally,
      // where the #13 call site fires again — is harmless.
      if (idemClaimed && idemKey) {
        const claimedKey = idemKey;
        const slot = ctx as { markEffectCommitted?: () => void };
        // THE-573 #1: this callback is installed by MUTATING ctx, so two CONCURRENT dispatches
        // sharing one CallerContext would have the second silently overwrite the first's callback.
        // The outer handler would then mark the INNER claim, its own effectCommitted would stay
        // false, and the catch would DELETE its claim — leaving a retry free to double-apply.
        //
        // Unreachable through the server (both context factories build a fresh object per MCP call,
        // and no handler re-enters dispatch), so this is library-API misuse. Refuse it LOUDLY rather
        // than make sharing work: silently corrupting an idempotency claim is far worse than a
        // failed second dispatch, and a caller that hits this has a bug worth seeing.
        //
        // Keyed on a LIVE overlapping dispatch, not on "this ctx was used before" — the callback is
        // removed in the finally below, so SEQUENTIAL reuse of one context is unaffected.
        if (slot.markEffectCommitted !== undefined) {
          throw new ObsidianTcError(
            "internal",
            "CallerContext is already in use by an in-flight dispatch; a context must not be shared across concurrent dispatches",
          );
        }
        slot.markEffectCommitted = () => {
          this.markEffectCommitted(ctx.db, ctx.vaultId, claimedKey, now());
          effectCommitted = true;
        };
        installedMarker = slot;
      }

      let handlerMs = 0;
      const out = await runAudited(
        {
          tool: def.name,
          auditUses: def.pathAcl != null && !CROSS_NOTE_REWRITE_TOOLS.has(def.name),
        },
        async () => {
          if (def.pathAcl) {
            const effVault = vaultArgOf(def, parsed.data) ?? ctx.vaultId;
            const root = this.rootResolver?.(effVault);
            if (root) {
              for (const { op, path } of def.pathAcl(parsed.data)) {
                // P1.4: pass the caller's granted scopes so a path's declared rule-scopes are
                // enforced here (the authoritative central stage), not just the folder allowlist.
                enforcePathAcl(ctx.acl, op, path, root, ctx.grantedScopes);
              }
            }
          }
          // THE-514: the last chance to bail before the handler — and any side effect — runs.
          // idemClaimed's claim is still pre-effect here, so the catch below deletes it cleanly.
          checkAborted(ctx.signal);
          const handlerStart = now();
          const r = await def.handler(parsed.data, ctx);
          handlerMs = Math.max(0, now() - handlerStart);
          handlerReturned = true;
          // #13: the default marker point — the WHOLE handler returned, so any later fault is
          // post-effect. This alone leaves a window for a MULTI-STEP handler that commits effect #1
          // and then does more fallible work before returning (a throw in between would delete the
          // claim and let a retry double-apply). THE-572 closes that window from the handler side:
          // such a handler calls ctx.markEffectCommitted() at its own first durable effect, which
          // sets the same marker earlier. This call stays as the backstop for every single-effect
          // handler (and re-fires harmlessly when the handler already signalled).
          if (idemClaimed && idemKey) this.markEffectCommitted(ctx.db, ctx.vaultId, idemKey, now());
          return r;
        },
      );
      // THE-278 hardening (warn-mode): the handler's success payload must match the advertised
      // outputSchema. Validate and surface drift to the operator, but never throw — a schema
      // mismatch must not turn a working call into a client-visible failure.
      if (def.outputSchema) {
        const outCheck = def.outputSchema.safeParse(out);
        if (!outCheck.success) {
          try {
            this.onInternalError?.(
              `output_schema:${name}`,
              ctx.vaultId,
              new Error(`output does not match advertised outputSchema: ${outCheck.error.message}`),
            );
          } catch {
            /* diagnostics sink must never break dispatch */
          }
          // THE-417 Phase 2: a DEDICATED seam, not the stderr line above.
          //
          // Warn-mode's whole job is to surface latent mismatches over real traffic, and until now
          // its only output was one stderr line among every other internal error. Nobody greps
          // that, so "let warn-mode run for a while" was not actually a runnable instruction — the
          // same registered-but-never-emitting shape THE-585 found in three dead gauges.
          //
          // Deliberately NOT parsed back out of the `output_schema:` prefix above: a stringly-typed
          // discriminator on a diagnostics message is exactly the kind of coupling that breaks
          // silently when someone reworks the message.
          try {
            this.onOutputSchemaDrift?.(name, ctx.vaultId);
          } catch {
            /* observability is never load-bearing */
          }
          // THE-457: in strict mode (dev/CI) a schema-contract violation is a hard, typed error —
          // caught by the dispatch handler below and returned as internal_error — rather than
          // silently shipping a payload a conformant client may reject. Production stays warn-only.
          if (this.strictOutputSchema) {
            throw new ObsidianTcError(
              "internal_error",
              `output does not match advertised outputSchema for ${name}`,
            );
          }
        }
      }
      const json = JSON.stringify(out ?? null);
      const resultSize = Buffer.byteLength(json, "utf8");
      const duration = Math.max(0, now() - start);

      if (resultSize > this._maxResponseBytes) {
        // Idempotency post-effect: the handler's side effect has ALREADY committed by here, and
        // markEffectCommitted (above) already durably marked the claim 'effect_committed' before we
        // got here. Do not delete the claim — that would let a retry with the same key re-execute the
        // committed effect. Instead FINALIZE it with the real over-limit size and a tiny marker (never
        // the oversized payload), so a retry replays the same overflow error via the result_size
        // re-check on the claimed-row path. #13: if the finalize below itself faults (caught), the row
        // stays 'effect_committed' rather than reverting to in-flight — a retry (or a reclaim after a
        // crash) resolves it to a durable indeterminate_outcome, never re-executing the handler. The
        // finalize fault itself is fully covered; only the pre-marker window remains (see the residual
        // note at the markEffectCommitted call site above).
        if (idemClaimed && idemKey) {
          this.meter((m) => m.incIdempotencyCacheSkipped(ctx.vaultId, name));
          try {
            this.finalizeIdempotency(ctx.db, ctx.vaultId, idemKey, "null", resultSize, now());
          } catch (finalizeErr) {
            // A finalize fault here leaves the row 'effect_committed' (not in-flight) — #13's durable
            // marker means a retry resolves to indeterminate_outcome rather than re-executing. Surface
            // it to the operator sink rather than swallowing it; it must not mask the overflow response
            // the caller is about to receive.
            try {
              this.onInternalError?.(`idempotency_finalize:${name}`, ctx.vaultId, finalizeErr);
            } catch {
              /* diagnostics sink must never break dispatch */
            }
          }
        }
        const e = new ObsidianTcError("overflow", "response exceeds byte budget", {
          result_size: resultSize,
          limit: this._maxResponseBytes,
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
            overflow_bytes: resultSize - this._maxResponseBytes,
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
        // THE-572: a handler that signalled mid-execution may have done so INSIDE its own
        // transaction (the recommended shape when the first effect is a ctx.db write). If that
        // transaction then rolled back, the marker rolled back with it and NOTHING was committed —
        // so the in-memory `effectCommitted` flag alone would strand a false `indeterminate` on a
        // call that is perfectly safe to retry. Consult the DURABLE state instead: it is the only
        // record that rolled back in lockstep with the effect. A read fault here resolves toward
        // "committed", because over-reporting an indeterminate is recoverable and a wrong delete
        // is not.
        let durablyCommitted = false;
        if (effectCommitted) {
          try {
            durablyCommitted =
              this.readIdempotency(ctx.db, ctx.vaultId, idemKey)?.state === "effect_committed";
          } catch {
            durablyCommitted = true;
          }
        }
        if (handlerReturned || durablyCommitted) {
          // #13: post-effect fault — NEVER delete; record indeterminate so a retry gets a definite
          // answer instead of re-executing the committed effect.
          try {
            this.finalizeIndeterminate(ctx.db, ctx.vaultId, idemKey, now());
          } catch (finErr) {
            try {
              this.onInternalError?.(`idempotency_indeterminate:${name}`, ctx.vaultId, finErr);
            } catch {
              /* diagnostics sink must never break dispatch */
            }
          }
        } else {
          // pre-handler failure: safe to release the slot so a legitimate retry re-runs.
          try {
            this.deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
          } catch {
            /* cleanup best-effort; must not mask the original error */
          }
        }
      }
      // THE-573: an abandoned transaction is an operator-grade fault — the connection may still be
      // INSIDE a transaction, so later reads can observe uncommitted rows and the next BEGIN either
      // fails or silently joins it. inTransaction/inSavepoint attach it to the thrown error rather
      // than replacing the error that explains the failure, which reaches the CALLER; reporting it
      // separately here is what makes it reach an OPERATOR, who would otherwise only ever log
      // err.message. Reported for typed errors too: the transaction is just as abandoned when the
      // handler failed for an ordinary, well-typed reason.
      const rollbackErr = (e as { rollbackError?: unknown } | null)?.rollbackError;
      if (rollbackErr !== undefined) {
        try {
          this.onInternalError?.(`txn_rollback:${name}`, ctx.vaultId, rollbackErr);
        } catch {
          /* diagnostics sink must never mask the original failure */
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
    } finally {
      // THE-573 #1: remove the callback this dispatch installed. Without this, the "already in
      // use" guard above would fire on the SECOND sequential use of one context — turning a
      // legitimate pattern into an error while still not making concurrent sharing safe.
      if (installedMarker !== undefined) installedMarker.markEffectCommitted = undefined;
    }
  }
}
