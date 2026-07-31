import { SpanKind, type Tracer } from "@opentelemetry/api";
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
import { hitlSatisfiedByState } from "../elicit-request-state";
import { argsHash } from "../hash";
import type { MetricsRecorder, ToolCallStatus } from "../metrics/registry";
import { SPAN_ATTR } from "../otel/attrs";
import { withTraceCarrier } from "../otel/propagation";
import { callerHash, type RateLimiter } from "../throttle";
import { isCrossNoteAuditExempt, runAudited } from "../vault/acl-audit";
import { enforcePathAcl } from "../vault/acl-path";
import {
  annotateSpanResult,
  callStatusForError,
  DispatchObservability,
} from "./registry/dispatch-observability";
import {
  claimOrReplay,
  deleteIdempotency,
  extractIdempotencyKey,
  finalizeIdempotency,
  finalizeIndeterminate,
  markEffectCommitted,
  readIdempotency,
} from "./registry/idempotency";
import {
  applyVaultAcl,
  enforceVaultBinding,
  parseInput,
  vaultArgOf,
} from "./registry/input-binding";
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
import { ALLOW_ALL, isDisabled, type VisibilityCaller } from "./visibility";

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
export { TOOL_DOMAINS };

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

/** THE-514: a stage-boundary cooperative-cancellation check. Throws the same modelled
 *  `ObsidianTcError` the rest of dispatch throws (never a raw DOMException `AbortError`), so an
 *  abort surfaces through the normal catch/audit/metrics path below rather than as an unhandled
 *  rejection or an opaque `internal` error. A no-op when `signal` is absent or not yet aborted —
 *  every existing caller (no signal) sees no behavior change. */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw err.aborted();
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

/** THE-457 (audit #4): default strict output-schema validation ON in test/CI, so a handler whose
 *  payload drifts from its advertised outputSchema fails a test instead of shipping warn-only to a
 *  client. Vitest sets NODE_ENV=test, so the existing suite exercises every real handler under strict
 *  validation; OBSIDIAN_TC_STRICT_OUTPUT_SCHEMA=1 opts in elsewhere (a CI job, a local run). Production
 *  sets neither and stays warn-only for backward compatibility; an explicit strictOutputSchema wins. */
function strictOutputSchemaDefault(): boolean {
  return process.env.NODE_ENV === "test" || process.env.OBSIDIAN_TC_STRICT_OUTPUT_SCHEMA === "1";
}

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
      onAuditFailure: opts.onAuditFailure,
      onEpisode: opts.onEpisode,
    });
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
      const def = this.toolStore.get(name);
      if (!def) throw new ObsidianTcError("not_found", `unknown tool: ${name}`);
      // THE-219 dispatch guard: a disabled tool is removed from the surface entirely.
      // Reject before scope/validation with the same error an unregistered tool yields,
      // so a disabled tool is indistinguishable from one that was never registered.
      if (isDisabled(def, this.toolVisibility))
        throw new ObsidianTcError("not_found", `unknown tool: ${name}`);
      scopeClass = def.scopeClass ?? scopeClassOf(def.requiredScopes);

      // WP4.3: input-schema parse, THE-267 vault-binding guard, THE-295 per-vault ACL swap — see
      // registry/input-binding.ts for the full reasoning behind each (unchanged, only relocated).
      const inputData = parseInput(def, rawInput);

      if (def.requiredScopes.length > 0 && !ctx.authenticated)
        throw new ObsidianTcError("unauthorized", "authentication required for this tool");

      assertScopesGranted(ctx, def.requiredScopes, "missing required scope(s)");

      enforceVaultBinding(ctx, def, inputData);

      applyVaultAcl(ctx, def, inputData, this.aclResolver);

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
        const effVault = vaultArgOf(def, inputData) ?? ctx.vaultId;
        const kind = this.vaultKindResolver(effVault);
        if (kind === "docs" || kind === "system")
          throw err.forbidden(`${name} cannot mutate a ${kind}-kind vault`, {
            vault: effVault,
            kind,
          });
      }

      // Tool-specific precondition gate (D5). After scope/ACL, before HITL, so a
      // rejected precheck never consumes the single-use elicit token.
      if (def.precheck) await def.precheck(inputData, ctx);

      // Idempotency gate (D3). A keyed call claims a row in idempotency_keys; a
      // replay returns the cached result without re-running the handler. Runs after
      // auth/scope/ACL/precheck but BEFORE throttle/HITL: the lock must be claimed
      // atomically before the single-use elicit token is consumed, so two concurrent
      // identical requests can't each consume the token (TOCTOU). Authorization
      // (auth/scope/ACL) still runs before this gate, so it stays authoritative on replays.
      idemKey = extractIdempotencyKey(inputData);
      if (idemKey) {
        // WP4.2: the claim-or-replay decision (reclaim-and-retry, corrupt-blob recovery,
        // terminal-overflow replay) now lives in registry/idempotency.ts's claimOrReplay,
        // returning one explicit discriminated state instead of re-deriving it inline here. Only
        // the dispatch-shaped reaction to each state — error construction, audit/meter calls, the
        // result-serialization memo — stays here, unchanged in behavior from before the extraction.
        const claim = claimOrReplay(
          ctx.db,
          ctx.vaultId,
          idemKey,
          name,
          hash,
          // Pass the clock FUNCTION, not a single now() sample — claimOrReplay calls it at each of
          // the (up to) four points the original inline block did (initial claim, both reclaim-
          // window comparisons, retry claim), so it observes the same drift a stateful ctx.now
          // would (cross-vendor review, WP4.2).
          now,
          this.idempotencyTtlMs,
          this.idempotencyReclaimMs,
          this._maxResponseBytes,
        );
        switch (claim.kind) {
          case "claimed":
            idemClaimed = true;
            break;
          case "mismatch":
            throw new ObsidianTcError(
              "idempotency_key_mismatch",
              "idempotency key reused with a different tool or arguments",
              { key: idemKey },
            );
          case "in_flight":
            throw new ObsidianTcError("idempotency_in_flight", "operation in progress", {
              key: idemKey,
            });
          case "replay":
            if (claim.outcome === "indeterminate") return indeterminateReplay(idemKey);
            if (claim.outcome === "overflow") {
              // Terminal-overflow replay: the original call committed its side effect but its
              // response exceeded the byte budget, so the claim was finalized with the real
              // over-limit size and no payload. Replay the SAME overflow error rather than
              // re-executing or returning an absent/oversized payload.
              const overSize = claim.resultSize;
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
            // outcome === "ok": a normal completed call within budget — replay its cached result.
            memoizeSerialized(claim.data, claim.json);
            {
              const resultSize = claim.resultSize;
              const duration = Math.max(0, now() - start);
              audit("ok", duration, resultSize);
              this.meter((m) =>
                m.observeToolCall(ctx.vaultId, name, "ok", duration / 1000, resultSize),
              );
              this.meter((m) => m.incIdempotencyHit(ctx.vaultId, name));
              return {
                ok: true,
                data: claim.data,
                meta: { duration_ms: duration, result_size: resultSize },
              };
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
              deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
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
              deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
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
          markEffectCommitted(ctx.db, ctx.vaultId, claimedKey, now());
          effectCommitted = true;
        };
        installedMarker = slot;
      }

      let handlerMs = 0;
      const out = await runAudited(
        {
          tool: def.name,
          auditUses: def.pathAcl != null && !isCrossNoteAuditExempt(def.name),
        },
        async () => {
          if (def.pathAcl) {
            const effVault = vaultArgOf(def, inputData) ?? ctx.vaultId;
            const root = this.rootResolver?.(effVault);
            if (root) {
              for (const { op, path } of def.pathAcl(inputData)) {
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
          const r = await def.handler(inputData, ctx);
          handlerMs = Math.max(0, now() - handlerStart);
          handlerReturned = true;
          // #13: the default marker point — the WHOLE handler returned, so any later fault is
          // post-effect. This alone leaves a window for a MULTI-STEP handler that commits effect #1
          // and then does more fallible work before returning (a throw in between would delete the
          // claim and let a retry double-apply). THE-572 closes that window from the handler side:
          // such a handler calls ctx.markEffectCommitted() at its own first durable effect, which
          // sets the same marker earlier. This call stays as the backstop for every single-effect
          // handler (and re-fires harmlessly when the handler already signalled).
          if (idemClaimed && idemKey) markEffectCommitted(ctx.db, ctx.vaultId, idemKey, now());
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
            finalizeIdempotency(ctx.db, ctx.vaultId, idemKey, "null", resultSize, now());
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
        finalizeIdempotency(ctx.db, ctx.vaultId, idemKey, json, resultSize, now());
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
              readIdempotency(ctx.db, ctx.vaultId, idemKey)?.state === "effect_committed";
          } catch {
            durablyCommitted = true;
          }
        }
        if (handlerReturned || durablyCommitted) {
          // #13: post-effect fault — NEVER delete; record indeterminate so a retry gets a definite
          // answer instead of re-executing the committed effect.
          try {
            finalizeIndeterminate(ctx.db, ctx.vaultId, idemKey, now());
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
            deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
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
