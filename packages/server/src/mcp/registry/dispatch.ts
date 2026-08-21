import {
  err,
  ObsidianTcError,
  scopeClassOf,
  type ToolResult,
  type ToolVisibilityConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import { argsHash } from "../../hash";
import { callerHash, type RateLimiter } from "../../throttle";
import { isCrossNoteAuditExempt, runAudited } from "../../vault/acl-audit";
import { isDisabled } from "../visibility";
import { callStatusForError, type DispatchObservability } from "./dispatch-observability";
import {
  claimOrReplay,
  deleteIdempotency,
  extractIdempotencyKey,
  finalizeIdempotency,
  finalizeIndeterminate,
  markEffectCommitted,
  readIdempotency,
} from "./idempotency";
import { applyVaultAcl, enforceVaultBinding, parseInput } from "./input-binding";
import {
  assertScopesGranted,
  checkHitl,
  checkThrottle,
  enforceCentralPathAcl,
  enforceReadOnlyGate,
  enforceVaultKindGate,
  hitlRequired,
  isMutatingCall,
  requireAuthenticated,
  resolveOperationPolicy,
  runPrecheck,
} from "./policy-gates";
import {
  checkOutputSchema,
  isOverflow,
  memoizeSerialized,
  overflowError,
} from "./result-governance";
import type { ToolStore } from "./tool-store";
import type { CallerContext, EpisodeKind, RegistryOptions, Status, VerifyElicit } from "./types";
import { VERDICT_TOOL_TAG } from "./types";

// The dispatch orchestrator: the full try/catch/finally pipeline body, calling each gate
// (input-binding.ts, policy-gates.ts, result-governance.ts, idempotency.ts) in a fixed order.
// ToolRegistry (registry.ts) owns dispatch()/dispatchResource() and OTEL span wrapping; its
// runDispatch delegates here via one DispatchDeps object built once in the constructor.
// `ctx.now ?? Date.now` must be called at each existing call site, never hoisted into a
// pre-sampled value. See docs/design/mcp-dispatch-and-transport.md.

/** Everything runDispatch reads from ToolRegistry's construction-time config, bundled into one
 *  object so the function signature does not grow a positional parameter per field. Built once in
 *  ToolRegistry's constructor (not per-call) since every field here is itself immutable for the
 *  registry's lifetime. */
export interface DispatchDeps {
  toolStore: ToolStore;
  toolVisibility: ToolVisibilityConfig;
  observability: DispatchObservability;
  verifyElicit?: VerifyElicit;
  rateLimiter?: RateLimiter;
  idempotencyTtlMs: number;
  idempotencyReclaimMs: number;
  maxResponseBytes: number;
  strictOutputSchema: boolean;
  onInternalError?: RegistryOptions["onInternalError"];
  onOutputSchemaDrift?: RegistryOptions["onOutputSchemaDrift"];
  onProfile?: RegistryOptions["onProfile"];
  aclResolver?: RegistryOptions["aclResolver"];
  rootResolver?: RegistryOptions["rootResolver"];
  vaultKindResolver?: RegistryOptions["vaultKindResolver"];
}

/** THE-514: a stage-boundary cooperative-cancellation check. Throws the same modelled
 *  `ObsidianTcError` the rest of dispatch throws (never a raw DOMException `AbortError`), so an
 *  abort surfaces through the normal catch/audit/metrics path below rather than as an unhandled
 *  rejection or an opaque `internal` error. A no-op when `signal` is absent or not yet aborted —
 *  every existing caller (no signal) sees no behavior change. */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw err.aborted();
}

// Full invocation pipeline: validate -> auth -> scope/ACL -> HITL -> execute -> governor -> audit.
export async function runDispatch(
  deps: DispatchDeps,
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
  // THE-667: which rejection gate's release attempt failed, if any. Recorded rather than counted at
  // the gate, because the outer catch makes a SECOND delete attempt for every pre-handler failure
  // (see the `else` branch below) — so a gate-site failure alone does NOT mean the claim survived.
  // Counting there would fire on a transient failure that the retry then cleaned up, and the
  // counter has to mean "a claim was actually orphaned" to be worth alerting on.
  let releaseFailedGate: "throttle" | "hitl" | undefined;
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

  // THE-839: episode kind for the audit row. Everything here came through tools/call (resources/*
  // and prompts/* declare `protocol` via dispatchResource instead); a `verdict`-tagged tool is the
  // one exception — it judges OTHER episodes, so classifying it as ordinary work would let it
  // become its own evidence. Resolved from the tool's tags, inside the closure (def isn't looked
  // up until later). An unrecognised name falls through to `tool_call` — honest, since dispatch
  // rejects it moments later and that audit row is still a tool call.
  const episodeKind = (): EpisodeKind =>
    deps.toolStore.get(name)?.tags?.includes(VERDICT_TOOL_TAG) ? "verdict" : "tool_call";

  const audit = (status: Status, durationMs: number, resultSize: number, code?: string) =>
    deps.observability.recordOutcome(
      ctx,
      name,
      episodeKind(),
      hash,
      rawInput,
      status,
      durationMs,
      resultSize,
      code,
    );

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
    deps.observability.meter((m) => {
      m.incIdempotencyHit(ctx.vaultId, name);
      m.observeToolCall(ctx.vaultId, name, "error", duration / 1000, 0);
    });
    return {
      ok: false as const,
      error: e.toJSON(),
      // THE-741: this is a replay of a prior attempt's terminal state, not a fresh execution —
      // the handler did not run this time either.
      meta: { duration_ms: duration, result_size: 0, idempotent_replay: true },
    };
  };

  try {
    // THE-514: an already-cancelled call never even resolves the tool, let alone claims an
    // idempotency slot or spends an elicit token.
    checkAborted(ctx.signal);
    const def = deps.toolStore.get(name);
    if (!def) throw new ObsidianTcError("not_found", `unknown tool: ${name}`);
    // THE-219 dispatch guard: a disabled tool is removed from the surface entirely.
    // Reject before scope/validation with the same error an unregistered tool yields,
    // so a disabled tool is indistinguishable from one that was never registered.
    // THE-647 item 2: `ctx.toolVisibility` (a persona's own mask) rides along here too, so a
    // persona-disabled tool is rejected at dispatch, not just delisted — every caller without a
    // persona carries no `toolVisibility` and this check is unchanged for them.
    if (
      isDisabled(def, deps.toolVisibility, {
        grantedScopes: ctx.grantedScopes,
        readOnly: ctx.acl?.readOnly,
        toolVisibility: ctx.toolVisibility,
      })
    )
      throw new ObsidianTcError("not_found", `unknown tool: ${name}`);
    // THE-727: static scope class, set before parseInput ON PURPOSE — feeds the throttle decision
    // and error-path metrics even when parseInput itself fails, so a parse failure still gets a
    // real scope_class rather than "unknown". Refined after the parse below. See design note.
    scopeClass = def.scopeClass ?? scopeClassOf(def.requiredScopes);

    // WP4.3: input-schema parse, THE-267 vault-binding guard, THE-295 per-vault ACL swap — see
    // registry/input-binding.ts for the full reasoning behind each (unchanged, only relocated).
    const inputData = parseInput(def, rawInput);

    // THE-727: authorization is a property of the CALL, not only of the tool. Without
    // `def.resolvePolicy` this is the static declaration verbatim, so existing tools are untouched.
    // It sits between the parse and every gate that consumes it, which needed no reordering — the
    // pipeline already parsed before it authorized. THAT ORDERING IS LOAD-BEARING NOW and is pinned
    // by test: move `parseInput` back above this and a consolidated tool authorizes against the
    // wrong action's scopes.
    const policy = resolveOperationPolicy(def, inputData);
    scopeClass = policy.scopeClass;

    requireAuthenticated(ctx, def);

    assertScopesGranted(ctx, policy.requiredScopes, "missing required scope(s)");

    enforceVaultBinding(ctx, def, inputData);

    applyVaultAcl(ctx, def, inputData, deps.aclResolver);

    const mutating = isMutatingCall(policy);
    enforceReadOnlyGate(ctx, mutating);
    enforceVaultKindGate(ctx, def, inputData, mutating, name, deps.vaultKindResolver);

    await runPrecheck(def, inputData, ctx);

    // Idempotency gate (D3). A keyed call claims a row in idempotency_keys; a
    // replay returns the cached result without re-running the handler. Runs after
    // auth/scope/ACL/precheck but BEFORE throttle/HITL: the lock must be claimed
    // atomically before the single-use elicit token is consumed, so two concurrent
    // identical requests can't each consume the token (TOCTOU). Authorization
    // (auth/scope/ACL) still runs before this gate, so it stays authoritative on replays.
    idemKey = extractIdempotencyKey(inputData);
    if (idemKey) {
      // WP4.2: claim/replay decision-making (reclaim-and-retry, corrupt-blob recovery, terminal-
      // overflow replay) lives in registry/idempotency.ts's claimOrReplay, returning one explicit
      // discriminated state. Only the dispatch-shaped reaction — error construction, audit/meter
      // calls, result-serialization memo — stays here.
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
        deps.idempotencyTtlMs,
        deps.idempotencyReclaimMs,
        deps.maxResponseBytes,
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
            const e = overflowError(overSize, deps.maxResponseBytes);
            audit("error", duration, overSize, e.code);
            deps.observability.meter((m) => {
              m.incIdempotencyHit(ctx.vaultId, name);
              m.observeToolCall(ctx.vaultId, name, "error", duration / 1000, overSize);
            });
            return {
              ok: false,
              error: e.toJSON(),
              meta: {
                duration_ms: duration,
                result_size: overSize,
                overflow_bytes: overSize - deps.maxResponseBytes,
                // THE-741: the original call's committed effect is being replayed, not re-run.
                idempotent_replay: true,
              },
            };
          }
          // outcome === "ok": a normal completed call within budget — replay its cached result.
          memoizeSerialized(claim.data, claim.json);
          {
            const resultSize = claim.resultSize;
            const duration = Math.max(0, now() - start);
            audit("ok", duration, resultSize);
            deps.observability.meter((m) =>
              m.observeToolCall(ctx.vaultId, name, "ok", duration / 1000, resultSize),
            );
            deps.observability.meter((m) => m.incIdempotencyHit(ctx.vaultId, name));
            return {
              ok: true,
              data: claim.data,
              // THE-741: the cached result is being served — the handler did NOT run. Without this
              // marker a served-from-cache call is indistinguishable from a real execution to
              // every caller that only reads ok/data/error, including `rerun`.
              meta: { duration_ms: duration, result_size: resultSize, idempotent_replay: true },
            };
          }
      }
    }

    // THE-514: a boundary mid-pipeline. If idemClaimed is true here, the claim was JUST taken
    // above and the handler has not run — the catch below sees handlerReturned/effectCommitted
    // both false and deletes the claim, so a cancelled call never strands a claim that blocks a
    // legitimate retry.
    checkAborted(ctx.signal);

    // Dispatch-wide rate-limit gate (THE-210, G2.4 §Rate limits), keyed on (caller_hash,
    // scope_class, vault); an unknown scope class is unlimited. Runs BEFORE HITL so a throttled
    // call never consumes the single-use elicit token. Idempotent replays (returned from cache
    // above) are not re-counted — the original call already drew down the bucket, and a throttled
    // check itself costs no budget.
    const throttleDecision = checkThrottle(
      deps.rateLimiter,
      ctx.caller,
      scopeClass,
      ctx.vaultId,
      now(),
    );
    if (throttleDecision && !throttleDecision.ok) {
      deps.observability.meter((m) => m.incRateLimitHit(ctx.vaultId, scopeClass));
      if (idemClaimed && idemKey) {
        try {
          deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
        } catch {
          // THE-667: best-effort — releasing the claim must never replace the `throttled` error
          // the caller has to see. Record the gate; the outer catch retries this delete and only
          // counts it if that retry ALSO fails. See design note.
          releaseFailedGate = "throttle";
        }
      }
      throw err.throttled("rate limit exceeded", {
        scope_class: throttleDecision.scopeClass,
        retry_after_seconds: throttleDecision.retryAfterSeconds,
        current_burst: throttleDecision.currentBurst,
        current_rate: throttleDecision.currentRate,
      });
    }

    // HITL gate. A destructive/HITL-floored tool requires a valid single-use elicit
    // token; verifyElicit consumes it (UPDATE ... WHERE consumed_at IS NULL). Runs after
    // the throttle gate (so a rate-limited call doesn't burn the confirmation) and last
    // before the handler (so the token is spent only once the call is cleared to execute).
    const needsHitl = hitlRequired(policy);
    if (needsHitl) {
      const ok = checkHitl(ctx, hash, name, deps.verifyElicit);
      if (!ok) {
        deps.observability.meter((m) => m.incHitlElicited(ctx.vaultId, name));
        if (idemClaimed && idemKey) {
          try {
            deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
          } catch {
            // THE-667: same shape as the throttle gate above — the release must not replace the
            // `elicit_required` the caller has to see. Recorded, not counted; see the outer catch.
            releaseFailedGate = "hitl";
          }
        }
        throw new ObsidianTcError("elicit_required", "human confirmation required", {
          args_hash: hash,
        });
      }
      deps.observability.relay(ctx.vaultId, "tc.elicit.consumed", {
        tool: name,
        caller_hash: callerHash(ctx.caller),
        // THE-288 hardening: fingerprint, not the raw token (see morgianaData).
        elicit_token: ctx.elicitToken ? callerHash(ctx.elicitToken) : null,
      });
    }

    // THE-414: central folder-ACL enforcement — extract def.pathAcl's vault-relative paths and
    // enforce them HERE, right before the handler (handler-side enforcePathAcl calls remain as
    // defense-in-depth). Placed after HITL to mirror where handler-side enforcement used to run.
    // Wrapped in the (default-off) ACL-audit frame so a dev/test run can verify each pathAcl
    // extractor mirrors the handler's real fs usage (#280). Skipped when no root resolver is wired.
    // THE-572: install the mid-execution effect-committed signal AFTER every gate that can still
    // reject-and-release the claim, so the callback never outlives the claim it points at. Only
    // when this dispatch owns a claim — a keyless call leaves ctx.markEffectCommitted undefined.
    // Idempotent: signalling twice, or signalling then returning normally, is harmless. See
    // design note for the #13 marker-point reasoning.
    if (idemClaimed && idemKey) {
      const claimedKey = idemKey;
      const slot = ctx as { markEffectCommitted?: () => void };
      // THE-573 #1: mutating ctx to install this means two CONCURRENT dispatches sharing one
      // CallerContext would silently overwrite each other's callback and let a retry double-apply
      // a committed effect. Unreachable through the server today (each context factory builds a
      // fresh object per call), so this is refused LOUDLY as library-API misuse rather than made
      // safe. Keyed on a LIVE overlapping dispatch — removed in the finally below, so SEQUENTIAL
      // reuse of one context is unaffected.
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
        enforceCentralPathAcl(def, inputData, ctx, deps.rootResolver);
        // THE-514: the last chance to bail before the handler — and any side effect — runs.
        // idemClaimed's claim is still pre-effect here, so the catch below deletes it cleanly.
        checkAborted(ctx.signal);
        const handlerStart = now();
        const r = await def.handler(inputData, ctx);
        handlerMs = Math.max(0, now() - handlerStart);
        handlerReturned = true;
        // #13: the default marker point — the WHOLE handler returned, so any later fault is
        // post-effect. Leaves a window for a MULTI-STEP handler that commits effect #1 then does
        // more fallible work before returning; THE-572's ctx.markEffectCommitted() closes that
        // window from the handler side by setting the same marker earlier. This call stays as the
        // backstop for every single-effect handler (and re-fires harmlessly if already signalled).
        if (idemClaimed && idemKey) markEffectCommitted(ctx.db, ctx.vaultId, idemKey, now());
        return r;
      },
    );
    // WP4.3: output-schema validation (warn vs strict) — see registry/result-governance.ts's
    // checkOutputSchema for the full reasoning (unchanged, only relocated).
    checkOutputSchema(
      def,
      out,
      name,
      ctx,
      deps.strictOutputSchema,
      deps.onInternalError,
      deps.onOutputSchemaDrift,
    );
    const json = JSON.stringify(out ?? null);
    const resultSize = Buffer.byteLength(json, "utf8");
    const duration = Math.max(0, now() - start);

    if (isOverflow(resultSize, deps.maxResponseBytes)) {
      // Idempotency post-effect: the handler's side effect has ALREADY committed here — never
      // delete the claim, that would let a retry re-execute it. FINALIZE it with the real
      // over-limit size and a tiny marker (never the oversized payload) so a retry replays the same
      // overflow error. #13: a finalize fault here leaves the row 'effect_committed', not
      // in-flight — a later retry/reclaim resolves it to indeterminate_outcome, never re-runs the
      // handler. See design note for the residual-window analysis.
      if (idemClaimed && idemKey) {
        deps.observability.meter((m) => m.incIdempotencyCacheSkipped(ctx.vaultId, name));
        try {
          finalizeIdempotency(ctx.db, ctx.vaultId, idemKey, "null", resultSize, now());
        } catch (finalizeErr) {
          // A finalize fault here leaves the row 'effect_committed' (not in-flight) — #13's durable
          // marker means a retry resolves to indeterminate_outcome rather than re-executing. Surface
          // it to the operator sink rather than swallowing it; it must not mask the overflow response
          // the caller is about to receive.
          try {
            deps.onInternalError?.(`idempotency_finalize:${name}`, ctx.vaultId, finalizeErr);
          } catch {
            /* diagnostics sink must never break dispatch */
          }
        }
      }
      const e = overflowError(resultSize, deps.maxResponseBytes);
      audit("error", duration, resultSize, e.code);
      deps.observability.meter((m) => {
        m.incGovernorTruncation(ctx.vaultId, name);
        m.observeToolCall(ctx.vaultId, name, "error", duration / 1000, resultSize);
      });
      return {
        ok: false,
        error: e.toJSON(),
        meta: {
          duration_ms: duration,
          result_size: resultSize,
          overflow_bytes: resultSize - deps.maxResponseBytes,
        },
      };
    }

    if (idemClaimed && idemKey)
      finalizeIdempotency(ctx.db, ctx.vaultId, idemKey, json, resultSize, now());
    audit("ok", duration, resultSize);
    deps.observability.meter((m) =>
      m.observeToolCall(ctx.vaultId, name, "ok", duration / 1000, resultSize),
    );
    try {
      deps.onProfile?.({
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
      // THE-572: a handler may signal mid-execution INSIDE its own transaction. If that
      // transaction rolls back, the marker rolls back with it and NOTHING committed — so the
      // in-memory `effectCommitted` flag alone would strand a false `indeterminate` on a call
      // that's safe to retry. Consult the DURABLE state instead, since only it rolled back in
      // lockstep with the effect. A read fault here resolves toward "committed": over-reporting
      // indeterminate is recoverable, a wrong delete is not.
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
            deps.onInternalError?.(`idempotency_indeterminate:${name}`, ctx.vaultId, finErr);
          } catch {
            /* diagnostics sink must never break dispatch */
          }
        }
      } else {
        // pre-handler failure: safe to release the slot so a legitimate retry re-runs.
        try {
          deleteIdempotency(ctx.db, ctx.vaultId, idemKey);
        } catch {
          // THE-667: cleanup stays best-effort — must not mask the original error. This is the
          // LAST release attempt though, so its failure means the claim is genuinely orphaned;
          // counted here (not at the gates) because a gate-site failure this call then cleans up
          // has no consequence and must not alert. `gate` names the rejection that led here when
          // one did; `other` covers every other pre-handler failure. meter() is itself guarded.
          deps.observability.meter((m) =>
            m.incIdempotencyReleaseFailed(ctx.vaultId, name, releaseFailedGate ?? "other"),
          );
        }
      }
    }
    // THE-573: an abandoned transaction is an operator-grade fault — the connection may still be
    // INSIDE it, so later reads can observe uncommitted rows and the next BEGIN fails or silently
    // joins it. inTransaction/inSavepoint attach it to the thrown error rather than replacing the
    // caller-facing error; reported here separately so it reaches an OPERATOR (who would otherwise
    // only see err.message). Reported for typed errors too — the transaction is abandoned either way.
    const rollbackErr = (e as { rollbackError?: unknown } | null)?.rollbackError;
    if (rollbackErr !== undefined) {
      try {
        deps.onInternalError?.(`txn_rollback:${name}`, ctx.vaultId, rollbackErr);
      } catch {
        /* diagnostics sink must never mask the original failure */
      }
    }
    if (!(e instanceof ObsidianTcError)) {
      // THE-288: a non-typed throw is a server bug. Route the real error + stack to the
      // operator sink for diagnosis; the client response below stays the redacted `internal`.
      try {
        deps.onInternalError?.(name, ctx.vaultId, e);
      } catch {
        /* diagnostics sink must never mask the original failure */
      }
    }
    const error =
      e instanceof ObsidianTcError ? e : new ObsidianTcError("internal", "internal error");
    const duration = Math.max(0, now() - start);
    audit("error", duration, 0, error.code);
    deps.observability.meter((m) => {
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
