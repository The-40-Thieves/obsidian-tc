import { SpanKind, type Tracer } from "@opentelemetry/api";
import {
  err,
  type MorgianaEventData,
  type MorgianaEventType,
  ObsidianTcError,
  scopeClassOf,
  type ToolResult,
  type ToolVisibilityConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import { argsHash } from "../hash";
import type { MetricsRecorder, ToolCallStatus } from "../metrics/registry";
import { SPAN_ATTR } from "../otel/attrs";
import { withTraceCarrier } from "../otel/propagation";
import { callerHash, type RateLimiter } from "../throttle";
import { type DispatchDeps, runDispatch as runDispatchPipeline } from "./registry/dispatch";
import {
  annotateSpanResult,
  callStatusForError,
  DispatchObservability,
} from "./registry/dispatch-observability";
import { assertScopesGranted } from "./registry/policy-gates";
import {
  memoizeSerialized,
  strictOutputSchemaDefault,
  takeSerialized,
} from "./registry/result-governance";
import { ToolStore } from "./registry/tool-store";
import {
  type CallerContext,
  type DispatchEpisode,
  type DispatchProfile,
  type RegistryOptions,
  type Status,
  TOOL_DOMAINS,
  type ToolDefinition,
  type ToolDomain,
  type ToolIcon,
  type VerifyElicit,
} from "./registry/types";
import { ALLOW_ALL, type VisibilityCaller } from "./visibility";

// WP4.3: assertScopesGranted moved to registry/policy-gates.ts, memoizeSerialized/takeSerialized
// to registry/result-governance.ts — both unchanged, re-exported so every existing importer
// (resources.ts, mcp/server.ts) keeps working unchanged (check:facade-parity pins this file's
// export surface).
// THE-742: re-exported so consumers do not reach past this facade into `registry/policy-gates`.
// rerun.ts needs the read-only gate's exact message to tell its `forbidden` from the three other
// gates that throw the same code — a legitimate need that was being met by a deep import.
export { READ_ONLY_DENIAL_MESSAGE } from "./registry/policy-gates";
// WP4.1: types + tool storage now live under ./registry/ (types.ts, tool-store.ts). Re-exported
// here so every existing importer of this facade keeps working unchanged — check:facade-parity
// pins this file's export surface byte-for-byte against origin/main.
export type {
  CallerContext,
  DispatchEpisode,
  DispatchProfile,
  RegistryOptions,
  ToolDefinition,
  ToolDomain,
  ToolIcon,
};
export { assertScopesGranted, memoizeSerialized, TOOL_DOMAINS, takeSerialized };

export class ToolRegistry {
  // WP4.1: storage moved to registry/tool-store.ts (ToolStore) — a concrete owned instance, not an
  // interface seam (map constraint 6). ToolRegistry still resolves a definition by name at several
  // dispatch-body call sites below (unchanged this slice), now via toolStore.get(name).
  private readonly toolStore = new ToolStore();
  // WP4.2: the observability sinks (meter/relay/morgianaData/relayCompletion/emitCompletion/
  // recordOutcome) moved to registry/dispatch-observability.ts (DispatchObservability) — same
  // concrete-composition pattern as toolStore above. ToolRegistry's own meter/relay/etc. methods
  // below are now one-line delegations, so the dispatch-body call sites that use them (this slice
  // does not move the dispatch body) are unchanged.
  private readonly observability: DispatchObservability;
  private readonly _maxResponseBytes: number;
  private readonly verifyElicit?: VerifyElicit;
  private readonly tracer?: Tracer;
  private readonly rateLimiter?: RateLimiter;
  private readonly idempotencyTtlMs: number;
  private readonly idempotencyReclaimMs: number;
  private readonly toolVisibility: ToolVisibilityConfig;
  private readonly onProfile?: (p: DispatchProfile) => void;
  private readonly onInternalError?: RegistryOptions["onInternalError"];
  private readonly onOutputSchemaDrift?: RegistryOptions["onOutputSchemaDrift"];
  private readonly aclResolver?: RegistryOptions["aclResolver"];
  private readonly rootResolver?: RegistryOptions["rootResolver"];
  private readonly vaultKindResolver?: RegistryOptions["vaultKindResolver"];
  private readonly strictOutputSchema: boolean;
  // WP4.3: the dispatch orchestrator (registry/dispatch.ts) takes everything it needs as one
  // DispatchDeps object rather than reaching back into ToolRegistry — built once here (every field
  // is immutable for the registry's lifetime), not per-call.
  private readonly dispatchDeps: DispatchDeps;

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
    this.tracer = opts.tracer;
    this.rateLimiter = opts.rateLimiter;
    this.idempotencyTtlMs = (opts.idempotencyTtlSeconds ?? 86400) * 1000;
    this.idempotencyReclaimMs = (opts.idempotencyReclaimSeconds ?? 60) * 1000;
    this.toolVisibility = opts.toolVisibility ?? ALLOW_ALL;
    this.onProfile = opts.onProfile;
    this.onInternalError = opts.onInternalError;
    this.onOutputSchemaDrift = opts.onOutputSchemaDrift;
    this.aclResolver = opts.aclResolver;
    this.rootResolver = opts.rootResolver;
    this.vaultKindResolver = opts.vaultKindResolver;
    this.strictOutputSchema = opts.strictOutputSchema ?? strictOutputSchemaDefault();
    this.observability = new DispatchObservability({
      toolStore: this.toolStore,
      metrics: opts.metrics,
      emit: opts.emit,
      sessionTracer: opts.sessionTracer,
      traceContent: opts.traceContent,
      onAuditFailure: opts.onAuditFailure,
      onEpisode: opts.onEpisode,
    });
    this.dispatchDeps = {
      toolStore: this.toolStore,
      toolVisibility: this.toolVisibility,
      observability: this.observability,
      verifyElicit: this.verifyElicit,
      rateLimiter: this.rateLimiter,
      idempotencyTtlMs: this.idempotencyTtlMs,
      idempotencyReclaimMs: this.idempotencyReclaimMs,
      maxResponseBytes: this._maxResponseBytes,
      strictOutputSchema: this.strictOutputSchema,
      onInternalError: this.onInternalError,
      onOutputSchemaDrift: this.onOutputSchemaDrift,
      onProfile: this.onProfile,
      aclResolver: this.aclResolver,
      rootResolver: this.rootResolver,
      vaultKindResolver: this.vaultKindResolver,
    };
  }

  /** Record into the Prometheus recorder; a metrics error must never break dispatch (G2.4). */
  private meter(fn: (m: MetricsRecorder) => void): void {
    this.observability.meter(fn);
  }

  /** Emit one MORGIANA CloudEvent; a sink error must never break dispatch (G2.4 fail-soft). */
  private relay(vaultId: string, type: MorgianaEventType, data: Partial<MorgianaEventData>): void {
    this.observability.relay(vaultId, type, data);
  }

  /** See DispatchObservability.relayCompletion (registry/dispatch-observability.ts) — the MORGIANA
   *  completion-event fan-out shared by tool dispatch and dispatchResource's `emit` closure below. */
  private relayCompletion(
    vaultId: string,
    name: string,
    status: ToolCallStatus,
    code: string | undefined,
    data: Partial<MorgianaEventData>,
  ): void {
    this.observability.relayCompletion(vaultId, name, status, code, data);
  }

  /** Per-call MORGIANA events for a completed tool dispatch — see relayCompletion. */
  private emitCompletion(name: string, ctx: CallerContext, result: ToolResult): void {
    this.observability.emitCompletion(name, ctx, result);
  }

  /** THE-415: record ONE governed outcome — see DispatchObservability.recordOutcome. */
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
    this.observability.recordOutcome(
      ctx,
      name,
      hash,
      rawInput,
      status,
      durationMs,
      resultSize,
      code,
    );
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts any specific ToolDefinition for storage in the heterogeneous registry (see ToolStore).
  register(def: ToolDefinition<any, any>): void {
    this.toolStore.register(def);
  }
  list(): ToolDefinition[] {
    return this.toolStore.list();
  }
  /** Tools advertised by tools/list: the registered set minus those the visibility config
   *  hides/disables (THE-219) and those the caller cannot dispatch (THE-250). `list()` stays
   *  the full registered set. */
  /** THE-645 item 2: the config `listVisible` classifies with, for `inspect_visibility`. Exposed
   *  read-only so the inspector reads the SAME rules the registry enforces rather than a second
   *  copy parsed from server config — an inspector that can disagree with the enforcer is worse
   *  than no inspector. */
  visibilityConfig(): ToolVisibilityConfig {
    return this.toolVisibility;
  }

  listVisible(caller?: VisibilityCaller): ToolDefinition[] {
    return this.toolStore.listVisible(this.toolVisibility, caller);
  }
  has(name: string): boolean {
    return this.toolStore.has(name);
  }

  // One OTEL root span per tool call (G2.4) wraps the pipeline when a tracer is configured;
  // otherwise the tracer-less fast path runs unchanged. Span attributes come from ctx + the
  // ToolResult, so runDispatch's internals stay untouched.
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
            (this.toolStore.get(name)?.requiredScopes ?? []).join(","),
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

  /** WP4.3: the pipeline itself now lives in registry/dispatch.ts's runDispatch — this is a thin
   *  delegation to it with one DispatchDeps object (built once in the constructor), the same
   *  concrete-composition pattern WP4.1/4.2 used for ToolStore/DispatchObservability. */
  private async runDispatch(
    name: string,
    rawInput: unknown,
    ctx: CallerContext,
  ): Promise<ToolResult> {
    return runDispatchPipeline(this.dispatchDeps, name, rawInput, ctx);
  }
}
