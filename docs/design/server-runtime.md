# Server Runtime — Composition Root

Extracted from inline commentary, 2026-08-21; ownership and failure handling updated 2026-10-28. The code carries the invariants; this note carries the history and evidence.

## File overview / `buildServerRuntime` composition root

`buildServerRuntime` is the WP5.2 deliverable (issue 16); `wireRuntimeCore` (WP5.1, issue 15) was delivered first and declared the `ServerRuntime` shape plus the governance -> index-resources composition with construction-order-reversed cleanup over already-open stores. `buildServerRuntime` finishes the job: it is the actual composition root — stores -> otel/observability -> `wireRuntimeCore` -> job queue/health tools -> gateway seams -> job handlers -> index coordinator/watcher -> M1 -> bridge clients/capability snapshots -> M2-M8 -> MCP server -> transports -> scheduler — returning a `ServerRuntime` whose `start()` is the final activation step (fire the boot reconcile, start the scheduler ticking, connect stdio) and whose `close(reason)` is the ordered, idempotent shutdown. As a result, `cli.ts`'s `run_serve` is now three lines: build, install signal handlers (`./shutdown.ts`), start.

`buildServerRuntime` builds every boot resource in the SAME order `run_serve` used to build them inline, before this extraction.

The WP5 acceptance criterion this whole slice satisfies: "the runtime is constructible in a test without parsing process arguments." `wireRuntimeCore` and `buildServerRuntime` are both argv-free — they take an already-resolved `ServerConfig`/deps object and never touch `process.argv`.

### Why `stores` (and `otel`) are parameters to `wireRuntimeCore`, not built there

`ToolRegistry` (governance) needs the OTEL tracer and the Prometheus/MORGIANA observability module's `metrics`/`morgiana`, both of which the observability module (`runtime/observability.ts`) derives from `stores.db`. Real boot therefore has `buildServerRuntime`'s own OTEL-init + `createObservability` call sitting textually BETWEEN stores and governance.

Folding that gap into `wireRuntimeCore` would mean either reordering real boot steps (forbidden) or accepting an arbitrary "give me your deps" callback, which starts to look like the service-locator this file is told not to build. Taking `stores` as an input and folding its cleanup into `wireRuntimeCore`'s own unwind stack gets the same reverse-order guarantee without either problem: a failure in governance or index resources still closes stores, in the right order, and the boot-failure tests exercise exactly that.

`otel` (OTEL SDK init) shares this exact shape and was flagged, then fixed the same way: it also sits textually between `stores` and the `wireRuntimeCore` call in `buildServerRuntime`, for the same reason `stores` does — real boot's construction order forbids reordering it inside. `otel` is an optional param that `wireRuntimeCore` folds into its own unwind, sitting between `stores` and `governance` (its real open position), so a throw in governance or index resources closes it too — it is never built inside `wireRuntimeCore` itself.

## `ServerRuntime` (interface)

The map's target shape for WP5. `registry` is the one thing every caller of a fully-composed runtime needs; `start`/`close` are the two lifecycle verbs — nothing else is public runtime state. WP5.2 (`buildServerRuntime`) implements this; WP5.1 (`wireRuntimeCore`) only declared it.

## `requireBoot`

The established idiom (slice 2) (originally documented in cli.ts's header comment, before this extraction): a boot resource read through a closure before the `const`/`let` that holds it has executed is a bug if that closure is ever CALLED early, and correct — by construction, never called before boot finishes — otherwise. A thrown `Error` (never a non-null assertion, forbidden by lint) documents the invariant instead of silently returning undefined.

`requireBoot` moved into this file (from `cli.ts`) because `wireRuntimeCore` needs the same pattern for `indexHealth` (constructed one step after the registry that closes over it). `cli.ts` still uses it for `indexCoordinatorRef`/`schedulerRef` (WP5.2) and imports it from here.

## `OwnedLayer`

Layer names are a plain `string`, not a closed union. `buildServerRuntime` initially owns "stores" and, after initialization succeeds, "otel" in `preCoreLayers`. `wireRuntimeCore` takes those owners and adds "governance" and "indexResources" (the latter has no cleanup). After core construction succeeds, `postCoreLayers` retains "stores", "otel", and "governance", then adds "leaderElection", "watcher", and "transports" as each finishes construction. Only the scope responsible for the failed construction step unwinds its stack; an outer scope does not repeat a core unwind.

## `unwindReversed`

Runs each already-built layer's cleanup in REVERSE (most-recently-opened-first) order — the resource-acquisition-is-cleanup pattern `wireRuntimeCore` uses when a later wiring step throws. Exported and independently testable: a layer that was never built never contributed a cleanup, so it can never be touched here, and reversing (or dropping) an entry in `layers` is exactly the bug class this function exists to make loud — see `server-runtime.test.ts`.

Each close is awaited independently. A close failure is reported to stderr and does not prevent the remaining owners from closing or replace the original construction error, which the caller rethrows after unwinding. `onCleanup` runs after each close attempt, including a failed attempt. Observer failures are also reported; failures in the diagnostic stream cannot interrupt cleanup. This helper is for construction failure handling. Normal `Stores.close()` attempts each owned handle once and reports close failures through `AggregateError`.

## Store construction and release

`wireStores` registers each database handle immediately after its open succeeds. Cache provisioning, experiential provisioning, identity resolution, or capture-port construction failures unwind acquired handles in reverse order. `provisionExperientialDb` owns its handle until migrations succeed and closes it if migration fails; `wireStores` only registers that handle after provisioning returns, avoiding overlapping ownership. With all experiential gates off, the handle is released during construction. Its close wrapper makes later store cleanup a no-op for that handle.

These internal store failures occur before `buildServerRuntime` receives the stores, so they do not call its `onCleanup` observer. The tests in `stores-failure-cleanup.test.ts` cover this ownership boundary and distinguish construction errors from normal close errors.

## `RuntimeCoreDeps.otel`

Already-initialized OTEL handle, opened between `stores` and the `wireRuntimeCore` call in real boot (see "Why `stores` (and `otel`) are parameters" above). Optional: `buildServerRuntime` always supplies it; direct callers may omit it, leaving one fewer cleanup entry. When present, `shutdown()` is called best-effort through `unwindReversed`. The shared unwinder reports a rejection and continues cleanup while preserving the original construction error; there is no local `.catch` that silently discards an OTEL shutdown failure.

## `RuntimeCoreDeps.configDir`

`dirname(configPath)` — the trust root for `embeddings.modulePath` (the module hatch). See `ResolveContext.configDir`'s doc comment (`providers/types.ts`) for the exact undefined-vs-set cases: it is NOT undefined in zero-config vault-path mode, only when `configPath` itself is absent.

**Correction (review round 2, Minor 5):** an earlier version of this comment claimed `configDir` was "undefined when derived from a vault path" — that claim was false and has been corrected to the description above.

## `RuntimeCoreDeps.onCleanup`

Test-only observability: fires with each layer's name after its cleanup was attempted, in reverse acquisition order. Only invoked when a later step throws during construction — never on the happy path, and never by production callers, which omit it. A throwing observer cannot prevent cleanup or replace the construction error.

## `wireRuntimeCore`

Composes governance -> index resources on top of already-open stores, with no process-argument parsing — the map's acceptance criterion for WP5 ("the runtime is constructible in a test without parsing process arguments"), scoped to what this slice actually extracted. If governance or index resources throws during construction, every already-built layer's cleanup — INCLUDING the stores (and, when supplied, otel) handed in — is attempted in reverse order via `unwindReversed` before the original error propagates. A failing close is reported and cannot skip the remaining owners.

OTEL opens right after stores in real boot, so its cleanup slots into `built` before governance is attempted, after stores. `unwindReversed` owns best-effort error handling for this entry, just as it does for the other layers.

## `SHUTDOWN_DRAIN_MS`

Cap on how long graceful shutdown waits for in-flight index work. Value (5000ms) is unchanged from `cli.ts`'s pre-extraction value — the map's WP5 acceptance criterion is that this timeout does not change.

## `buildServerRuntime` — `configDir` derivation

Trust root for a `module` provider's `modulePath` (`embeddings.modulePath` / `reranker.modulePath`) — cwd in a container is arbitrary, so a relative `modulePath` is resolved against the config FILE's directory instead, and refused entirely when `configPath` is absent (see `module-loader.ts`).

**Correction (review round 2, Minor 5):** `configPath` is NOT always a config file — `cli.ts`'s zero-config vault-path mode passes the VAULT directory as `configPath`, so `configDir` here becomes that vault directory's PARENT, not undefined. The module hatch's relative-path refusal does not fire in that mode (a relative `modulePath` would resolve against the vault's parent instead) — it is just unreachable today because nothing configures `provider: "module"` from zero-config mode. `dirname` of a RELATIVE `configPath` (e.g. `--config cfg.json`) is `"."`, i.e. still cwd-relative — passing an absolute `--config` is what actually makes this a fixed trust root.

## `buildServerRuntime.onCleanup` (parameter)

Test-only observability: fires after each already-built layer's cleanup attempt in three construction failure windows:

- Before core construction: `preCoreLayers` reports stores and, if initialized, OTEL. This includes telemetry/observability setup and evaluation of core arguments.
- During `wireRuntimeCore`: the same callback is passed through to core, which reports its own stack. The outer pre-core scope does not close those owners again.
- After core succeeds: `postCoreLayers` reports retained core owners and any successfully constructed later layers.

Never invoked on the happy path, and never passed by production callers (`cli.ts`). `runtime-boot-cleanup.test.ts` covers these handoffs, including argument-evaluation failure and exactly-once cleanup across overlapping scopes.

## `preCoreLayers` (in `buildServerRuntime`)

After stores return, `buildServerRuntime` owns their cleanup while initializing OTEL, retrieval caches, telemetry, and observability. OTEL joins the stack only after initialization succeeds. Ownership transfers to `wireRuntimeCore` only after the complete `RuntimeCoreDeps` object has been evaluated and immediately before invoking core. Thus an argument getter or setup function that throws still unwinds OTEL then stores, while a core failure is cleaned up solely by core.

## `buildServerRuntime.planeEnabledExplicit` (parameter)

Whether the raw config file explicitly set `plane.enabled` (vs. absent and defaulted). Governs `start()`'s boot-time opt-in notice (`plane-opt-in-notice.ts`). Defaults to `true` ("assume explicit") so non-`run_serve` callers (`rerun.ts`, tests) never nag by accident — `cli.ts`'s `run_serve` is the one production caller and passes the real computed value.

## `postCoreLayers` (in `buildServerRuntime`)

After `wireRuntimeCore` succeeds, `postCoreLayers` starts with stores, OTEL, and governance. Leader election, the vault watcher, and transports are appended only after each finishes construction. A later failure attempts cleanup in reverse order: transports (if built), watcher, leader election, governance, OTEL, then stores. For example, the metrics endpoint's non-loopback-bind refusal occurs inside `wireTransports`, so the transports entry is absent but all earlier owners still unwind. `indexResources` contributes no cleanup of its own and is not repeated here.

## `close()` — job-runner drain (`#14`)

No explicit contradiction drain happens here any more — durable jobs survive the process exiting mid-lease (`claim()`'s lease-expiry reclaim picks them up), so nothing is LOST by skipping a final drain. One bounded best-effort pass (`jobRunner.drainOnce`, bounded by `SHUTDOWN_DRAIN_MS`) still gives a live worker a chance to clear the queue before exit rather than always waiting out the lease.
