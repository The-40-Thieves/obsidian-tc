# Server Runtime — Composition Root

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

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

THE-466 slice 2's established idiom (originally documented in cli.ts's header comment, before this extraction): a boot resource read through a closure before the `const`/`let` that holds it has executed is a bug if that closure is ever CALLED early, and correct — by construction, never called before boot finishes — otherwise. A thrown `Error` (never a non-null assertion, forbidden by lint) documents the invariant instead of silently returning undefined.

`requireBoot` moved into this file (from `cli.ts`) because `wireRuntimeCore` needs the same pattern for `indexHealth` (constructed one step after the registry that closes over it). `cli.ts` still uses it for `indexCoordinatorRef`/`schedulerRef` (WP5.2) and imports it from here.

## `OwnedLayer`

Layer names are a plain `string`, not a closed union: `wireRuntimeCore` uses its own fixed set ("stores"/"otel" (only when supplied)/"governance"/"indexResources"), while `buildServerRuntime`'s own post-`wireRuntimeCore` unwind stack reuses the same `OwnedLayer`/`unwindReversed` machinery for a different set ("watcher"/"transports") — the mechanism is identical, only the inventory of what got built differs.

## `unwindReversed`

Runs each already-built layer's cleanup in REVERSE (most-recently-opened-first) order — the resource-acquisition-is-cleanup pattern `wireRuntimeCore` uses when a later wiring step throws. Exported and independently testable: a layer that was never built never contributed a cleanup, so it can never be touched here, and reversing (or dropping) an entry in `layers` is exactly the bug class this function exists to make loud — see `server-runtime.test.ts`.

## `RuntimeCoreDeps.otel`

Already-initialized OTEL handle, opened between `stores` and the `wireRuntimeCore` call in real boot (see "Why `stores` (and `otel`) are parameters" above). Optional: `buildServerRuntime` always supplies it, but the direct `wireRuntimeCore` tests construct no OTEL and omit it, so `built` simply has one fewer entry and behaves exactly as before this was added. When present, `shutdown()` is called best-effort (its own rejection is swallowed) — a telemetry SDK failing to shut down during unwind must never replace the real construction error that is propagating.

## `RuntimeCoreDeps.configDir`

`dirname(configPath)` — the trust root for `embeddings.modulePath` (the module hatch). See `ResolveContext.configDir`'s doc comment (`providers/types.ts`) for the exact undefined-vs-set cases: it is NOT undefined in zero-config vault-path mode, only when `configPath` itself is absent.

**Correction (review round 2, Minor 5):** an earlier version of this comment claimed `configDir` was "undefined when derived from a vault path" — that claim was false and has been corrected to the description above.

## `RuntimeCoreDeps.onCleanup`

Test-only observability: fires with each layer's name, in the order its cleanup actually ran. Only invoked when a later step throws during construction — never on the happy path, and never by production callers, which omit it.

## `wireRuntimeCore`

Composes governance -> index resources on top of already-open stores, with no process-argument parsing — the map's acceptance criterion for WP5 ("the runtime is constructible in a test without parsing process arguments"), scoped to what this slice actually extracted. If governance or index resources throws during construction, every already-built layer's cleanup — INCLUDING the stores (and, when supplied, otel) handed in — runs in reverse order (via `unwindReversed`) before the error propagates, so a partial boot never leaks an open db handle or a live OTEL exporter.

Inline: otel opens right after stores in real boot, so its cleanup slots into `built` too — before governance is attempted, after stores. Best-effort by construction: `.catch` swallows a `shutdown()` rejection so it can never replace the real error `unwindReversed` is already propagating.

## `SHUTDOWN_DRAIN_MS`

THE-457: cap on how long graceful shutdown waits for in-flight index work. Value (5000ms) is unchanged from `cli.ts`'s pre-extraction value — the map's WP5 acceptance criterion is that this timeout does not change.

## `buildServerRuntime` — `configDir` derivation

Trust root for a `module` provider's `modulePath` (`embeddings.modulePath` / `reranker.modulePath`) — cwd in a container is arbitrary, so a relative `modulePath` is resolved against the config FILE's directory instead, and refused entirely when `configPath` is absent (see `module-loader.ts`).

**Correction (review round 2, Minor 5):** `configPath` is NOT always a config file — `cli.ts`'s zero-config vault-path mode passes the VAULT directory as `configPath`, so `configDir` here becomes that vault directory's PARENT, not undefined. The module hatch's relative-path refusal does not fire in that mode (a relative `modulePath` would resolve against the vault's parent instead) — it is just unreachable today because nothing configures `provider: "module"` from zero-config mode. `dirname` of a RELATIVE `configPath` (e.g. `--config cfg.json`) is `"."`, i.e. still cwd-relative — passing an absolute `--config` is what actually makes this a fixed trust root.

## `buildServerRuntime.onCleanup` (parameter)

Test-only observability: fires with each already-built layer's name, in the order its cleanup actually ran, on either failure window this function covers — a construction step AFTER `wireRuntimeCore` throws (reports its own post-core layers), or `wireRuntimeCore` itself throws (reports stores/otel/governance via the same callback, passed straight through to the `wireRuntimeCore` call). Never invoked on the happy path, and never passed by production callers (`cli.ts`).

## `buildServerRuntime.planeEnabledExplicit` (parameter)

THE-825: whether the raw config file explicitly set `plane.enabled` (vs. absent and defaulted). Governs `start()`'s boot-time opt-in notice (`plane-opt-in-notice.ts`). Defaults to `true` ("assume explicit") so non-`run_serve` callers (`rerun.ts`, tests) never nag by accident — `cli.ts`'s `run_serve` is the one production caller and passes the real computed value.

## `postCoreLayers` (in `buildServerRuntime`)

Everything from the `wireRuntimeCore` call onward is built on top of an already-successful `wireRuntimeCore` — a later construction failure (e.g. the metrics endpoint's non-loopback-bind refusal, deep in `wireTransports`) must still close what `buildServerRuntime` itself went on to open: the vault watcher (`indexCoordinator` has no other stop path) and any transport socket, then governance and stores, in reverse order — the same `unwindReversed` contract `wireRuntimeCore` used, extended to the layers WP5.2 adds. `indexResources` contributes no cleanup of its own (see `wireRuntimeCore`), so it is not repeated here.

## `close()` — job-runner drain (`#14`)

No explicit contradiction drain happens here any more — durable jobs survive the process exiting mid-lease (`claim()`'s lease-expiry reclaim picks them up), so nothing is LOST by skipping a final drain. One bounded best-effort pass (`jobRunner.drainOnce`, bounded by `SHUTDOWN_DRAIN_MS`) still gives a live worker a chance to clear the queue before exit rather than always waiting out the lease.
