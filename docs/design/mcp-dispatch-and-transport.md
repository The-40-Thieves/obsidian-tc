# MCP Dispatch & Transport

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## dispatch.ts — runDispatch (module header)

`runDispatch` is the WP4.3 extraction of the dispatch orchestrator: the full try/catch/finally
pipeline body was moved here **unchanged** from `registry.ts`. Every gate's own logic already
lived in a sibling leaf module (`input-binding.ts`, `policy-gates.ts`, `result-governance.ts`,
`idempotency.ts`) before this move; what got relocated is only what was left after that — the
try/catch/finally skeleton, the mutable per-dispatch state (`scopeClass`, `idemKey`, `idemClaimed`,
`handlerReturned`, `effectCommitted`, `installedMarker`), and the fixed gate-call sequence
documented in the WP4 refactor map.

`ToolRegistry` (in `registry.ts`) still owns `dispatch()` / `dispatchResource()` and the OTEL span
wrapping; its private `runDispatch` method is now a thin delegation to this function, built from one
`DispatchDeps` object assembled once in the constructor — the same concrete-composition pattern
WP4.1/4.2 used for `ToolStore` / `DispatchObservability`.

The `now` clock (`ctx.now ?? Date.now`) is called at the exact same points and the same number of
times as before the move — the commit that performed the move has the full call-site list — so
nothing was hoisted into a pre-sampled value during the refactor.

## dispatch.ts — scopeClass (THE-727)

The static `scopeClass` assignment (before `parseInput` runs) is set there **on purpose**, not by
oversight. THE-727's ticket text proposed relocating this line to below the parse; that would have
been a regression: a call that fails `parseInput` never reaches the policy resolver, so leaving
`scopeClass` at its default `"unknown"` would have silently degraded every parse-failure throttle
and error-path metric. It stays before the parse and is refined (to the policy-resolved value)
after the parse instead.

## dispatch.ts — idempotency-claim release accounting (THE-667)

The `releaseFailedGate` bookkeeping exists because an earlier version of the throttle/HITL
gate-rejection paths had **no channel at all** for a release failure — the `catch` around
`deleteIdempotency` was a bare best-effort swallow, full stop. That is still correct behavior (the
release must never replace the `throttled` / `elicit_required` error the caller has to see), but it
left a truly orphaned claim invisible.

The fix: record which gate's release attempt failed (`releaseFailedGate`), and let the outer catch
make a **second** delete attempt for every pre-handler failure. Only if that second, final attempt
also fails is the claim counted as genuinely orphaned (`incIdempotencyReleaseFailed`). Counting at
the gate site would have alerted on transient failures the retry then cleaned up — the counter has
to mean "a claim was actually orphaned" to be worth paging on.

## dispatch.ts — central path-ACL enforcement and effect-commit marker install (THE-414, THE-572)

THE-414 moved folder-ACL enforcement for `def.pathAcl` paths to run centrally, immediately before
the handler, instead of depending on every handler remembering to call `enforcePathAcl` itself
(handler-side calls remain as defense-in-depth, not removed). It runs wrapped in a default-off
ACL-audit frame (#280) so a dev/test run can assert that each tool's `pathAcl` extractor actually
mirrors the paths the handler touches on the real filesystem.

THE-572 installs the `ctx.markEffectCommitted` callback at this same point in the pipeline — after
every gate that can still reject-and-release the idempotency claim (throttle, HITL), so the callback
can never outlive the claim it points at. It is a plain property mutation on the per-dispatch `ctx`
object, the same pattern the per-vault ACL swap earlier in the pipeline uses. The underlying UPDATE
is guarded on `completed_at IS NULL`, so calling it twice — or calling it and then having the
handler return normally (which fires the `#13` default marker call site again) — is harmless.

## dispatch.ts — concurrent CallerContext sharing (THE-573 #1)

Because the `markEffectCommitted` callback above is installed by *mutating* `ctx`, two concurrent
dispatches sharing one `CallerContext` object would silently overwrite each other's callback: the
second dispatch's install would clobber the first's, so the *outer* handler's effect-commit signal
would end up marking the *inner* dispatch's claim. The outer dispatch's own `effectCommitted` flag
would then stay `false`, and its `catch` block would delete its own (already-effect-committed)
claim — leaving a retry free to double-apply the outer call's effect.

This is unreachable through the server today: both context factories (stdio and HTTP) build a fresh
`CallerContext` per MCP call, and no handler re-enters `dispatch`. Hitting the guard therefore means
library-API misuse, not a live server bug. The chosen response is to refuse loudly — throw an
`internal` `ObsidianTcError` — rather than make concurrent sharing safe: silently corrupting an
idempotency claim is a far worse failure mode than a rejected second dispatch, and a caller that
triggers this has a real bug worth seeing immediately.

The guard is keyed on a **live overlapping** dispatch (`slot.markEffectCommitted !== undefined`),
not on "this ctx object was ever used before" — the callback is removed in the `finally` block, so
sequential reuse of one `CallerContext` across separate, non-overlapping calls is unaffected.

## dispatch.ts — the #13 effect-commit marker and its residual window

The default marker point for "the effect is committed" is simply "the whole handler returned"
(`handlerReturned = true`, then `markEffectCommitted` for a keyed call). That alone leaves a window
for a **multi-step** handler: one that commits its first durable effect and then does more fallible
work before finally returning. A throw in that window would (absent THE-572) delete the idempotency
claim and let a retry double-apply the already-committed effect. THE-572's
`ctx.markEffectCommitted()` closes that window from the handler side by letting the handler signal
its own first durable effect explicitly, earlier than its return. The `#13` call site at handler
return remains as the backstop for every single-effect handler, and re-fires harmlessly if the
handler already signalled.

On the overflow path, if the `finalizeIdempotency` call itself faults (caught), the row is left in
state `'effect_committed'` rather than reverting to `'in-flight'`. A later retry, or a reclaim after
a crash, resolves that row to a durable `indeterminate_outcome` — it never re-executes the handler.
That finalize-fault case is therefore fully covered. The one residual gap is the window *before*
either `markEffectCommitted` or the handler's return happens at all — i.e., before any marker has
been set — which is the same pre-marker window described above.

## server.ts — createMcpServer capabilities (SEP-2575 listChanged)

Declaring `listChanged: true` for each subscribable type is not cosmetic. The `subscriptions/listen`
handler acknowledges a subscription filter only for types the server declared as capable of
`listChanged`; an undeclared type is silently dropped from the filter. The stream still opens and
the ack still comes back (carrying `notifications: {}`), so nothing looks wrong from the client's
side — it simply waits forever for events that were never actually subscribed. Measured during
development: without these capability declarations, every `notify` publish reached zero listeners
and nothing errored anywhere in the pipeline.

## server.ts — dual protocol-era support (THE-583)

Serving both the 2025-11-25 and 2026-07-28 (`MODERN_PROTOCOL_VERSION`) wire codecs from one server
was verified end-to-end against LiteLLM's actual pinned `mcp` 1.28.1 client (whose ceiling is
2025-11-25): the negotiation settled on 2025-11-25, `tools/list` returned the expected tools, and a
tool call round-tripped successfully. LiteLLM is the gateway in front of this server, so dropping
legacy-era support outright would have taken the whole MCP plane down for every existing caller.

## server.ts — server/discover reachability (SEP-2575)

An earlier revision of the comment on this handler warned that `server/discover` was **not**
reachable at all. That was true at the time: it was written when this server was hand-wired to a
bare `Server` + transport directly, and the SDK routes a request through the wire registry of the
protocol era the *connection* was classified as — which stateless serving left permanently
undefined. Switching to serving through `createMcpHandler`, which classifies the era **per
request**, is what actually makes the method route. The claim is now pinned by
`mcp-protocol-eras.test.ts` end to end, rather than left to a comment that could silently stop being
true the next time the serving path changed.

## server.ts — protocol-era construction parameter (THE-583)

An earlier version of `McpServerOptions.era` was not a constructor parameter at all — the code read
the negotiated protocol version directly off `server.getNegotiatedProtocolVersion()`. Because this
server is stateless (there is no initialize/initialized handshake), that call returns `undefined` on
every single request, including one that plainly carried `MCP-Protocol-Version: 2026-07-28` in its
headers. The old code therefore silently emitted no 2026-only field at all, on every request, while
still looking like correctly-era-aware code. `era` is now supplied explicitly by the caller
(`createMcpHandler`'s per-request classification), closing that gap.

## server.ts — logging/setLevel (THE-583, THE-725/THE-862)

This server used to register its own hand-written `logging/setLevel` handler. That handler was dead
code that read as a feature: once the `logging: {}` capability is declared (as it is here), the
SDK's own `Server` constructor auto-registers a built-in `logging/setLevel` handler that answers
`{}` and wins over any handler this code tries to register itself. The hand-written handler was
removed rather than left in place looking implemented. See `docs/MCP-CLIENT-COMPAT-MATRIX.md`
(Finding 2, THE-725/THE-862) for the full compatibility matrix this interacts with.

## server.ts — tool-call error text (THE-823)

The text block returned in a `CallToolResult` on a dispatch failure used to carry only
`code + message + retryable`. Real MCP clients drop `structuredContent` on an `isError` result and
render only the text block, so that short sentence was the caller's **entire** diagnostic surface —
it never named which field was wrong (e.g. which Zod validation issue fired). `formatErrorDetail`
was added specifically to append the capped, human-readable issue detail into the text itself so a
model has something to act on and self-correct from.

## server.ts — facade envelope validation (THE-823)

`CALL_CAPABILITY_SCHEMA`'s `args` field used to be declared `z.record(...).default({})`. That meant
a caller who wrote `"arguments"` instead of `"args"` in its envelope silently fell through to the
schema's default empty object — the target tool was then dispatched with zero arguments and
reported **its own** "missing required fields" error, never surfacing the caller's actual mistake
(the misnamed envelope key). `facade.ts`'s schemas are now `z.strictObject`, so an unrecognized
envelope key now surfaces as one `unrecognized_keys` Zod issue naming the offending key directly.

## server.ts — resources/templates/list (SEP-2549)

This handler did not exist at all before it was added. Without it, the SDK answered a bare `-32601`
for the method — so a client probing the resource surface saw the **method itself** as unsupported,
rather than learning (correctly) that the server simply publishes no URI templates because every
resource here is a concrete vault note enumerated via `resources/list`.

## server.ts — elicitation shape comparison (THE-583, SEP-2260/2322)

The 2026-07-28 `inputRequired` shape answers a confirmation requirement with an opaque state that
the client echoes back verbatim on retry — a shape any generic, spec-compliant MCP client already
knows how to complete without server-specific code. The older `elicit_required` error plus a bespoke
`elicit_token` argument required a client to have been written specifically against this server's
own convention. The new path is offered only to modern-era callers that both wired an `elicitCodec`
and advertised form-elicitation support; every other caller still gets the old error and token path.

## http.ts — session tracking on the HTTP transport (THE-726)

Before THE-726, this transport carried **no concept of a session at all** — `sessionId` and
`activeSessions` appeared zero times in this file — while the stdio factory tracked sessions via a
process-local in-memory map. Because production traffic reaches this server over HTTP, that gap was
the entire reason `session_id` was `NULL` on 100% of `chunk_retrievals` and `agent_episodes` rows.
It was not a wiring defect in an otherwise-working feature and not a client-adoption problem — it
was a transport that could not carry a session no matter what the client called.

The stdio in-memory tracker is documented as "process-local and best-effort: not persisted, so a
restart simply resumes untracked." That is an acceptable trade-off for one local operator process,
but not for concurrent HTTP clients surviving a restart — which is why the HTTP path resolves the
caller's session durably from SQLite on every request instead of caching it.

THE-726 slice 3 (`sessions.autoOpen`): "client adoption" — getting every client to actually open a
session — was recorded as the remaining blocker to closing the session-tracking gap. But every
client that would need to change is one this project does not control. The same reasoning that made
the original missing-session problem a **transport** gap rather than a client-adoption gap applies
again here: a server-side answer (having the server open an implicit session itself when none
exists) was available, so it was taken. It stays off by default — privacy is a deliberate design
input, per `SessionsConfigSchema` — in which case the behavior is byte-identical to the resolve-only
path.

## http.ts — per-app vs. per-request MCP handler (THE-583)

The MCP handler used to be constructed **per request**, and the original reason was sound: the
caller context was captured in a closure over that specific request's verified identity, so a
long-lived handler risked leaking one caller's authorization into a different caller's request. That
same constraint is what made a long-lived `subscriptions/listen` stream impossible to support — the
handler serving such a stream was torn down the instant the request that created it returned.

THE-583 moved to one handler per app instead, preserving caller isolation through a different
mechanism: `createMcpHandler` invokes its factory once per **serving unit** (one HTTP request) and
hands that invocation the request's own `authInfo`, which the SDK treats as strictly pass-through
(it never reads headers or verifies anything itself). The caller context is therefore still built
fresh per request from that request's identity — it now arrives as an argument instead of being
captured in a closure. This isolation guarantee is asserted by
`test/http-caller-isolation.test.ts`, which drives two different tokens through the **same** handler
instance and fails if either one observes the other's scopes or vault.

## http.ts — Bun keep-alive bug (THE-561) and its regression harnesses (THE-730)

`@hono/node-server`'s Node-compatibility `http.Server` measurably dropped **~25%** of requests that
arrived on a reused keep-alive connection, surfacing as `ECONNRESET` — a failure mode that a
connection-pooling client such as LiteLLM's `httpx` hits constantly under normal load. This is why
the transport prefers Bun's native server when running under Bun (the Bun-vs-Node choice itself
lives in `serveHono`, since it is a process-wide decision — see THE-659 there).

Two Bun-only regression harnesses exist for this: `bun-smoke/http-keepalive-reuse.test.ts` and
`bun-smoke/dual-http-servers.test.ts`, both intended to run under `bun test bun-smoke`. THE-730
records a gap that existed between them: an earlier comment named the two tests together as though
they were equivalently wired into that run, but the first test actually lived at
`test/http-keepalive-reuse.bun.ts` — a path no test runner in the project actually invoked — so only
the second test was ever really exercised. THE-730 fixed the location so both are reachable.

## http.ts — Tasks extension routing (THE-583)

Measured during development: a `tasks/get` handler registered directly on the underlying `Server`
object is never actually consulted, even when the connection classifies as `era=modern`, because
`createMcpHandler` validates the inbound method name against the spec's method registry and answers
`-32601` for anything it does not recognise — including extension methods — before any registered
handler runs. A raw transport (one that bypasses `createMcpHandler`) *does* route the same method
correctly, which is what made this difference easy to miss while developing against one serving path
and deploying against the other. The fix is to intercept and answer Tasks-extension methods directly
in the Hono route, before delegating to `handler.fetch`.

## http.ts — reportAuthRejection token-TTL hint

The extra diagnostic hint appended when a rejected token's `exp` claim is still in the future (i.e.
the token was refused for exceeding `auth.tokenTtlSeconds`, not for having actually expired) exists
because of a specific operational incident: a token that looked completely valid by every normal
measure (unexpired signature, unexpired `exp`) was being silently rejected by the operator-configured
TTL ceiling, and diagnosing that from the generic "invalid or expired token" response took far
longer than it should have. The fix — naming the misconfiguration directly in the operator-facing
stderr line — was characterized at the time as "the one line that would have made a 5-day outage a
5-minute one."
