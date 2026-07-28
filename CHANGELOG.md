# Changelog

All notable changes to obsidian-tc are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the spirit of
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.13.0] - 2026-07-28

### Added

- **MCP SDK v2 + the 2026-07-28 protocol revision, alongside 2025-11-25 (THE-583, #543).** The server now
  speaks **both** protocol eras from one endpoint. A 2026-07-28 client can call tools with no
  `initialize` handshake at all (SEP-2575 removed it); a 2025-11-25 client is unaffected and still
  negotiates exactly as before.

  Migrated from `@modelcontextprotocol/sdk@1` to the v2 package split —
  `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, both 2.0.0. The v1 SDK moves to
  **devDependencies**: it is retained deliberately as a *real* legacy client for the roundtrip
  tests, which is stronger evidence of back-compatibility than a hand-written 2025-era request.

  Serving the modern era is **opt-in** — the SDK's shipped `SUPPORTED_PROTOCOL_VERSIONS` is
  2025-only, so an unmodified v2 server answers a 2026 client with `400 Unsupported protocol
  version`. Worth knowing if you vendor this: the opt-in must be set on `ServerOptions`, because
  `Server.connect()` overwrites the transport's copy with the server's — setting it on the transport
  throws nothing and silently leaves the server legacy-only.

  Back-compatibility was verified against the exact client the deployment depends on (LiteLLM's
  `mcp` 1.28.1, protocol ceiling 2025-11-25): negotiated `2025-11-25`, listed tools, called one.
  `test/mcp-protocol-eras.test.ts` pins both eras plus a floor asserting an unadvertised revision is
  still refused.

- **Foundation for the MCP Tasks extension over the durable queue (THE-583, #548).** Tasks left the core
  protocol in 2026-07-28 and was redesigned around polling (`tasks/get`, `tasks/cancel`;
  `tasks/list` removed). The SDK ships **no runtime** for it, so this is an implementation of the
  extension rather than an adoption — verified first that extension methods do route through
  `setRequestHandler` on a modern connection.

  The `jobs` table gains nullable `vault_id` / `caller` columns. **NULL is the meaningful default:**
  a job with no owner is internal maintenance work and is never visible over MCP. Every existing row
  and every existing `enqueue` call site — reconcile, contradiction, synthesis, audit, index writes —
  stays invisible without being touched. Visibility is opt-in at enqueue, not opt-out at read.

  That matters because the queue was never caller-scoped: exposing it as-is would have let any
  authenticated caller read any job by id, including `payload` and `last_error`, which carry vault
  paths and error text. A foreign task id and a missing one now answer identically, so the lookup
  cannot be used to enumerate another caller's ids.

  `tasks/get` and `tasks/cancel` are served on modern connections. They are answered **in front of**
  the SDK handler, not through it: `createMcpHandler` validates an inbound method against the spec
  registry and answers `-32601` for anything unrecognised, extension methods included — a handler
  registered on the `Server` for `tasks/get` is never consulted. (A raw transport *does* route it,
  which is what made the difference easy to miss.)

  A foreign task id and a missing one answer identically, so the surface cannot be used to enumerate
  another caller's ids, and cancelling someone else's work — a write, not a read — is refused.

- **Logging, Roots and Sampling wired (THE-583, SEP-2577 deprecation window, #546, #550).** The 2026-07-28
  revision deprecated these three server→client features but did not remove them, and the SDK still
  implements all three — so a client mid-migration can still use them.

  The server now advertises the `logging` capability and emits `notifications/message`. The first
  real use: when the byte governor **truncates** a response, the client is told. That was previously
  visible only in `meta` and server-side metrics, so a caller could act on a shortened result
  believing it complete.

  `roots` and `sampling` are consulted per connection and gated on the client having advertised
  them — calling either against a client that did not is a protocol error, not a soft miss.
  Sampling is deliberately **not** a fallback for the LiteLLM gateway: the gateway is chosen,
  configured and budgeted by the operator, while the client's model is whatever the caller happens
  to be running, so substituting one for the other would move inference and its data exposure to a
  party the operator never selected.

  **`logging/setLevel` is not routable in SDK v2** — it is absent from both the 2025 and 2026 wire
  registries and a handler registered for it answers `-32601`. The verbosity floor is therefore
  fixed at `info` rather than settable; a handler was written, measured as dead, and removed instead
  of being left in place looking implemented.

- **HITL confirmation now uses the 2026-07-28 multi-round-trip shape (THE-583, SEP-2260/2322, #546).** A
  destructive call from a modern client is answered with `inputRequired` carrying an opaque,
  HMAC-signed `requestState`; the client re-issues the same call echoing it back and the server
  verifies it before any handler runs. Previously this was an `elicit_required` error plus a bespoke
  `elicit_token` argument that only a client written against this server could complete.

  The 2025 token path is untouched and still serves legacy callers, so both eras work. The round
  trip is offered **only** when the client advertised form elicitation — the SDK rejects an
  `inputRequired` naming a capability the client never declared, so offering it unconditionally
  would turn "needs confirmation" into a hard protocol error for clients that cannot prompt a human.

  A confirmation is bound to tool, arguments, vault **and** caller: approving one write does not
  authorize another.

  **Known trade, accepted deliberately:** `requestState` is authenticated and TTL-bounded but *not
  consumed*, where the `elicit_tokens` table it supersedes was single-use
  (`UPDATE … WHERE consumed_at IS NULL`). Within the TTL a captured confirmation can authorize the
  same call more than once. A test asserts this replay behaviour explicitly so it cannot be mistaken
  for the old semantics; restoring one-time use means a consumed-nonce table and does not require a
  wire change.

- **Adopt SDK helpers over hand-rolled equivalents (THE-583, #544).** Three duplicated implementations now
  defer to the SDK, removing second copies of wire constants and validation logic:

  * **`_meta` key constants** — `client-info.ts` and `otel/propagation.ts` had hand-typed literals
    for `io.modelcontextprotocol/clientInfo`, `traceparent`, `tracestate` and `baggage`. They now
    re-export the SDK's. A drifted wire constant does not throw; it yields an absent clientInfo or a
    trace that quietly stops propagating.
  * **DNS-rebinding guard** — `validateHostHeader` / `validateOriginHeader` replace regex parsing.
    The `allowedHosts` allowlist is normalized to both `host:port` and bare-hostname forms first: the
    SDK matches on hostname while our config schema documents "Host header values", and passing those
    straight through would have 403'd every request for anyone who configured a port.
  * **RFC 9728 metadata URL** — now the SDK's derivation. **Behaviour fix:** for a resource carrying
    a path (`https://host/mcp`), RFC 9728 §3.1 inserts that path *after* the well-known suffix
    (`/.well-known/oauth-protected-resource/mcp`). Ours dropped it, collapsing two distinct resources
    on one host onto a single metadata document.

  The rebinding guard gained its first real coverage in the process — 8 tests over Host and Origin
  acceptance, using `node:http` because Node's `fetch` silently drops a custom `Host` header, which
  had made the first draft of those tests pass against loopback while appearing to test rebinding.

- **Full 2026-07-28 conformance (#544): `server/discover`, SEP-2243 routing headers, SEP-2549 cache hints
  (THE-583).** The `/mcp` route is now served by the SDK's `createMcpHandler`, which classifies the
  protocol era per request and serves both from one endpoint.

  This is what makes **`server/discover` (SEP-2575)** work. Hand-wiring `Server` + transport never
  establishes an era on a stateless connection, so every request fell back to the frozen 2025 wire
  registry — which has no such method and answered `-32601` regardless of what the client sent.

  **SEP-2243** routing headers (`Mcp-Method`/`Mcp-Name`) are enforced: a modern request whose
  headers and body disagree is refused, so a gateway cannot route on one method while the server
  executes another. **SEP-2549** adds `ttlMs`/`cacheScope` to cacheable results, on modern
  connections only. `cacheScope` is a security decision — `tools/list` and `resources/*` are
  `private` because they are scope- and ACL-filtered per caller; only `prompts/list` is `public`.

  `fetch-to-node` is **removed as a dependency**: `createMcpHandler` is web-standard fetch in,
  Response out, so the route no longer round-trips through Node req/res. THE-561's keep-alive
  harness still passes 40/40.

- **`obsidian-tc token mint` — reproducible, auditable bearer tokens (THE-658, #539).** There was no mint
  tooling at all, so every token this project runs on came from a Python one-liner in someone's
  shell history — which is how the live tokens ended up with no `aud` claim.

  ```
  obsidian-tc token mint [path] --sub <id> [--aud <uri>] [--vault <id>]
                                [--scopes a,b] [--ttl <sec>] [--json]
  ```

  It reads the config's own auth block, so a minted token matches what that server will actually
  verify: `aud` defaults to `auth.audience` (falling back to `auth.resource`, which is what
  `createHttpApp` binds to when PRM is configured), and `--ttl` defaults to `auth.tokenTtlSeconds`.
  The bare token goes to stdout so it composes — `TOKEN=$(obsidian-tc token mint …)` — with the
  human-readable summary on stderr. The signing secret is never echoed.

  Two refusals, each encoding a failure already paid for: it will not mint **without an `aud`** when
  the config binds one (jose rejects such a token as `missing_claim` on first use, and THE-456 makes
  an audience mandatory for a non-loopback `jwt` bind), and it will not mint a **`--ttl` above
  `auth.tokenTtlSeconds`**, which caps a token's *age* rather than its remaining life — a year-long
  `exp` under a 24h cap dies after a day while still looking valid, which previously took the MCP
  plane down for five days.

- **The MCP Tasks extension, complete (THE-583, #549, #552).** A long-running tool can now run as a
  background task and the client collects the answer later. Task creation is **server-directed**, as
  the revision specifies: a client declares `io.modelcontextprotocol/tasks` in its per-request
  capabilities and the server decides per call — there is no per-request flag (`params.task` was
  2025-11-25 vocabulary). Only tools marked `taskAugmentable` defer; everything else still answers
  synchronously, because a handle is worse than an answer for anything fast. Today that is
  `index_vault`.

  `tasks/get` returns the real result on a completed task and the JSON-RPC error on a failed one —
  deferred retrieval is the point of the extension, and the runner previously discarded what it
  produced. `tasks/update` and `tasks/cancel` acknowledge per the extension schema.

  `notifications/tasks` pushes task state to a subscribed client instead of making it poll. Polling
  remains the default and is fully supported.

  **Isolation:** a task is visible, cancellable and announced only to the caller and vault that
  created it. Internal maintenance work (reconcile, contradiction, synthesis, audit) carries no
  owner and is invisible over MCP by construction. A background task carries exactly the scopes its
  caller held at enqueue — it can never do more than that caller could have done synchronously.

- **`subscriptions/listen` (THE-583, SEP-2575, #551).** The single long-lived stream that replaces
  the removed HTTP GET endpoint and `resources/subscribe`/`unsubscribe`. Clients opt into
  `toolsListChanged`, `promptsListChanged`, `resourcesListChanged` or per-URI resource updates.

  Serving it required making the MCP handler persistent. It was built per request, which was correct
  for isolation but closed any stream the instant its creating request returned. The isolation is
  preserved by a different mechanism rather than dropped: the SDK invokes its factory once per HTTP
  request and hands it that request's pass-through `authInfo`, so a caller context is still built
  per request from that request's identity. Asserted by a test driving two tokens through the same
  handler, interleaved and concurrent.

- **`resources/templates/list` (THE-583, #554).** Previously unimplemented, so a client probing the
  resource surface saw the method as unsupported rather than seeing that we publish no templates.
  Now answers an empty list with a cache hint. Resources here are concrete vault notes enumerated by
  `resources/list`; there is no URI template to expand.

- **A 2026-07-28 conformance suite (THE-583, #554).** Pins the revision on the wire per changelog
  item, including the **removals** — `ping`, `logging/setLevel` and `initialize` are refused, since a
  deleted method still being answered is a conformance failure no feature test would notice.

### Fixed

- **Per-request log level (THE-583, SEP-2575, #549).** The revision made verbosity a per-request
  `_meta` field and requires that a server **MUST NOT** emit `notifications/message` for a request
  that did not carry one. Logging went through a session-keyed path that a stateless server never
  populates, so the byte-governor truncation notice reached clients that never asked for logging.

- **`resources/read` misses answer `-32602` (THE-583, #550).** They answered `-32603`, reporting a
  client mistake as a server fault on the one method the revision names for this code.

- **`forget` audit parity, including on a no-op (THE-609, #542).** `audit_events` now mirrors
  `forget_log` in every case, so a forget that matched nothing is still auditable.

### Changed

- **Protocol surface built for downstream clients, not just this deployment (THE-583, #550).**
  `x-mcp-header` (SEP-2243) is verified end to end so a tool author can declare header-carrying
  parameters; Roots and Sampling are reachable from every tool's context for their deprecation
  window rather than being removed as unused.

- **Request bodies are parsed once, not twice (THE-583, #553).** The body parsed for the Tasks
  extension checks is now handed to the SDK instead of being re-parsed on every MCP request.

## [1.12.1] - 2026-07-28

### Fixed

- **Enabling `observability.prometheus` no longer kills the MCP HTTP server under Bun (THE-659,
  #535).**
  With `prometheus.enabled: true`, every request to the MCP transport — any path, any method,
  authenticated or not — returned Bun's placeholder page (`Welcome to Bun! To get started, return a
  Response object.`) at **HTTP 200**, while the process logged `Expected a Response object, but
  received 'Response (lightweight) { … nativeResponse: undefined }'`. The MCP plane was completely
  dead and every status-code health check stayed green.

  The `/metrics` endpoint served its app with `@hono/node-server` while THE-561 had already moved
  the MCP transport to native `Bun.serve`. Starting the Node-compat server installs its HTTP
  machinery process-wide, after which Hono's responses are the "lightweight" variant that
  `Bun.serve` refuses. Both listeners now go through one `serveHono` helper
  (`src/transports/serve.ts`), because the Bun-vs-Node choice is a **process**-wide decision rather
  than a per-server one — mixing the two implementations is the defect. Guarded by
  `bun-smoke/dual-http-servers.test.ts`, which starts both servers in one process and asserts on
  response **bodies**; a test that starts only one server cannot see this failure, and one that
  checks only status codes reads 200 either way.

## [1.12.0] - 2026-07-27

### Changed (breaking)


- **`generate_uri`'s `vault` input is renamed `vault_name` (THE-589).** **Callers passing `vault`
  must rename it** — the tool's schema is `.strict()`, so the old key is now rejected with
  `validation_error` naming the unrecognized field. This is the only tool affected; no other input
  or tool changes.

  The field is an Obsidian **display name**, not a vault id, and always was. But the central
  vault-binding guard (THE-267) matches on the argument *name*: any string argument called `vault`
  is compared against the caller's bound vault id. So a vault-bound HTTP caller whose Obsidian
  display name differed from its configured vault id got `forbidden` from a tool that requires no
  scope, reads nothing, and only concatenates a string. Reproduced before the fix:
  `{vault: "My Notes"}` with bound vault `main` returned
  `forbidden: vault is not the caller's bound vault`.

  Renamed rather than exempting the tool from the guard, so no bypass is added to a
  security-relevant check. Unbound (trusted stdio) callers were never affected.

  (THE-589, #476.)

### Added

#### Vault change detection

- **The server now watches each vault and reindexes notes changed outside it** (THE-649, #524).
  `docs/SYNC.md` had described this since before it existed, in two places, on the primary
  integration path — there was no watcher. Every sync tier that document describes delivers Markdown
  by writing to disk, so this is a filesystem watch rather than the companion plugin's event stream.
  Changes are read-ACL-gated identically to a `write_note`. Eligibility mirrors `walkVault` exactly,
  and takes **two** guards: `lstat` rejects symlinks (as the walk does), `readNote` rejects hard
  links (`nlink > 1`) — neither covers the other, and the first draft shipped a hard-link bypass.
  **Not started on Windows**: Node's recursive `fs.watch` terminated the test process there, and
  whether a long-lived server is affected is unverified. Configurable via `watch.enabled` /
  `watch.debounceMs`.
- **Periodic vault reconcile** (`maintenance.reconcileIntervalMinutes`, THE-458, #532). Off unless
  set. Covers the watch's blind spots (Windows, `ENOSPC`, network mounts, `add_vault` vaults) and
  refreshes derived graph edges, which single-note writes never densify.

#### Retention — four growth curves bounded

- **Session traces are pruned by age** (`observability.retention.tracesDays`, THE-610, #523). The
  sweep's first filesystem arm. Orphans from a failed `start_session` age out on the same rule.
- **Dead `agent_episodes` and aged `chunk_retrievals` are swept** (THE-610 arm 2, #528). Only
  tombstoned or bi-temporally expired episodes — a live episode is never touched at any age.
  `chunk_retrievals` defaults to a **year**, deliberately: `chunk_access_stats` is a view over it, so
  pruning rewrites activation and note-quality signals.

#### Observability

- **W3C trace context over MCP `_meta`** (SEP-414, #525). A trace beginning in a host application now
  continues through this server instead of starting a second, unrelated tree.
- **Client software identity** (`client_name` / `client_version` on the session row, THE-627, #526),
  read from per-request `_meta` rather than the `initialize` handshake — the shape that works under
  both the current spec and `2026-07-28`. NULL, never a placeholder, when the client sends nothing.
- **SQL write-lock wait, vec fallbacks, coalesced writes, scheduler health, HTTP construct time,
  retrieval stage funnel, content-bytes, ingest counters, query-cache effectiveness, cold-start
  `boot.*`** (THE-585 / THE-507 / THE-515: #472, #474, #475, #486, #463, #446, #461, #458). Includes
  THE-585 items #1 (index-coordinator depth) and #6 (the retrieval stage funnel), and three gauges
  that were catalogued and fed by nothing for many releases.
- **The OTEL SDK no longer rides the tool registry's import graph** (THE-515, #489) — it loaded in
  every process, `serve` or not.
- **Budget deferral is reachable** (`scheduler.eventLoopDeferMs`, #530). It was built, tested and
  unpassable, so `scheduler_deferred_total` read 0 for every release since it shipped.
- **Config provenance** — every resolved value traceable to its source (THE-518, #437).
- **Retrieval policy provenance** logged (THE-538, #434).

#### Tool surface

- **Every registered tool declares an `outputSchema`** — 150/150 (THE-417, #479, #480, #481, #482).
- **Graph analytics**: centrality, communities, path tracing (THE-452, #436).
- **Structured recovery hints on every error response** (THE-512, #427).
- **Idempotency and `vaultArg` declared on the tool surface**; facade domain membership moved onto
  tool definitions (THE-513, #492, #499).
- **`AbortSignal` threaded through the dispatch pipeline** (THE-514, #490).
- **Cross-surface dispatch parity gate** (#512).
- **`note_quality` rollup, offline scorer and read-only report surface** (THE-537, #435).
- **Multi-query fan-out** exposed on `vault_graph_search` and a `decompose_and_research` prompt
  (THE-448, #450, #453) — **measured worse** (−0.047 nDCG@10, p=0.0004) and therefore opt-in.

#### Retrieval and performance

- **Query-product cache** keyed by vault generation + ACL fingerprint (THE-497, #432).
- **Forward vector scope closes the delta-kNN discovery gap** (THE-533, #438).
- **Densify directly instead of a full reindex per cell** (THE-532, #464).
- **Perf harness**: SQLite lock contention (#531), notes/s + embed tokens/s + per-vault denominator
  (#533), densification scenario (THE-581, #452), an I/O contention channel (THE-584, #473), a
  baseline refusal when the workload shifts without a count change (#477), Node portability runs
  (THE-494, #433), and a gate that notices what it was not handed (THE-534, #441). Baselines
  re-recorded on the CI runner (#448, #456, #459). kNN sweep pre-registered (THE-532, #460).
- **Synthetic multi-hop golden slice generator** (THE-652, #529), sized from the measured MDE.

#### Developer experience

- **JSON Schema published for `obsidian-tc.config.json`** (#465).
- **Dependency graph emitted; the plugin package is scanned** (#469).
- **Model service runtime Python deps locked** (#468).
- **Live LangExtract extraction wired in docs-ingest** (THE-444, #487).
- **`check-ticket-drift`** flags open tickets the code already cites (THE-540, #431).
- **Test concurrency bounded to the host** — worker cap, cross-process lock, cgroup backstop (#517).

### Fixed

- **A judge failure is `unjudged`, not `no_conflict`** (THE-613, #522). A gateway outage was
  byte-identical to a clean vault.
- **`patch_note` replace no longer consumes an entire note** (THE-603, #510) — it had truncated a
  912-line note to 30.
- **`work_forget` writes the forget-log audit row** (THE-600, #511).
- **`add_observation`'s read + render + append share one write lock** (THE-573, #484, #445).
- **The one genuinely exposed deferred-`BEGIN` site converted**, not the nine listed (THE-587, #478).
- **Exact KNN ties broken by `chunk_id`** so nDCG is host-independent (THE-582, #451).
- **`vault_generation` bumped by derived-plane writers too** (THE-579, #442).
- **Jobs-table growth bounded** — terminal retention sweep + id-only payload (THE-571, #444).
- **Migration SQL embedded** so standalone binaries actually run (THE-578, #430).
- **`treeDirty` read its own output**, so it was always true (THE-581, #455).
- **Unresolved side of cross-path dedup counted** (THE-588, #491).
- **`recordIngestStats` threaded through the MCP `index_vault` path** (THE-590, #502).
- **Native I/O test asserts what the loaded implementation produces** (THE-608, #521).
- **Docs no longer describe deleted config keys as working** (THE-598, #505); streaming walk and
  `gatedRerank` given a config surface (THE-591, #495).
- **`docgen:facts-check` has a non-empty floor** and the `ci-prose-suggest` firehose is removed
  (THE-601, #527); metrics catalog generated and the marker scan widened (THE-595, #493);
  bidirectional marker guard + docs-ingest CI (#488).
- **Tool-count gate no longer passes while stale** (THE-580, #443); all 38 unmapped tools mapped to
  facade domains and gated (THE-577, #426); G2.1's tool snapshot date-stamped (THE-596, #501).
- **`TREE.md` / `dependency-graph.json` stop conflicting by construction** (#504).
- **`packages/shared` TypeScript pin aligned with root** (THE-597, #500).
- **The vacuous `not-to-dev-dep` rule replaced with a source-scan gate** (THE-593, #494).
- **`SECURITY.md` supported-version table corrected and drift-gated** (THE-562 P0.3b, #483).
- **Release fixes**: version derived from `package.json` rather than the ref name (#429), publish
  straight to the release dist-tag (THE-574, #425), a partially-failed release made resumable
  (THE-575, #424).
- **THE-458 remainders closed** — reachable deferral, dead `registerPlaneScheduler` removed, size
  caps on the two regressed files (#530). Control arm settled and asserted before measurement
  (THE-532, #462). Default-surface decision recorded and the tool count de-duplicated (#476).

## [1.11.0] - 2026-07-24

### Verification and release infrastructure

Six PRs landed after the version was rolled and before the tag was pushed. They are in the 1.11.0
artifact, so they are documented here rather than deferred to 1.12.0. No runtime behaviour changes.

- **Release tags are now signed and CI refuses an unverified one** (THE-528, #421 + #422). The `v*`
  tag triggers the entire release — image build, npm publishes, SBOMs, provenance — and was the one
  input nothing authenticated. A maintainer key is registered and its public half committed to
  `.github/allowed_signers`; `verify-tag` enforces. Two defects were fixed to make that real: the
  job **gated nothing** (no `needs:` edge, so `build-native` ran in parallel and a failing check
  could not stop an immutable npm publish), and adding that edge would have broken every
  `workflow_dispatch` dry run until guarded on `github.ref_type`. Verified in both directions —
  a signed listed signer passes, an unlisted signer and an unsigned tag each exit 1.
- **New gates: `cargo-deny`, `typos`, `lychee`, `actionlint`, `osv-scanner`, `trivy`** (#414, #417,
  #419). Each was configured down to a genuine zero first — unconfigured they report 120, 318 and
  318 findings respectively on correct code, because this repo deliberately contains truncated SQL
  fixtures, homoglyph poison-scanner payloads, and Astro root-relative links. `trivy` scans the
  built image, closing a layer every lockfile scanner is blind to. `knip` is configured but
  deliberately not gated: its remaining findings are invisible-to-static-analysis by design.
- **`docs-ingest`'s web path was dead and is fixed** (#419). It called a metered hosted API whose
  credits are exhausted (HTTP 402) with no fallback, so every `http(s)` and `.html` ingest failed.
  Now renders through a self-hosted crawl4ai server over plain HTTP — no new dependency.
- **TREE.md's dependency graph is generated and drift-gated** (`just map`, THE-470, #418). It
  carried a standing "will drift" warning and had: 232 modules/785 dependencies committed against a
  real 246/978.
- **Dead code removed** (THE-570, #420): the superseded in-memory contradiction drainer, two dead
  exports, and its boundary-gate allowlist entry. Unreachable modules 4 → 3.
- **Four live 404s fixed on the published docs site** (#420), found by link-checking the *built*
  output — three stale `/obsidian-tc/` prefixes left by the move to a custom domain, and a
  `favicon.svg` referenced by every page with no such file. Source-level checking cannot see these:
  a root-relative link has no meaning relative to a `.md` file.
- **An SBOM of the container image** (#420). The existing step runs `npm sbom` — dependency trees
  only — so the Debian base, bun runtime and native binary that actually ship had no bill of
  materials.
- **Pre-commit hooks** (#419): seven gates via `prek`, previously CI-only.

### Added

- **`doctor` surfaces retrieval-head readiness independently** (`retrieval.heads` check; audit #16):
  the health surface reported no per-head status, so a `retrieval.sparse`/`retrieval.colbert` stream
  enabled in config but unbacked by the embeddings provider (only `bge-m3`/`model-tier` emit the
  multi-vector heads) was a silent no-op. `obsidian-tc doctor` now reports **dense**, **sparse**,
  **ColBERT**, and **reranker** readiness separately — each `ready` / `off` / `INERT` (enabled but the
  provider emits no head, a warning with remediation) — so an operator can see which streams are
  actually live. Derived from `config.embeddings` + `config.retrieval`; no runtime probe.
- **Vendor / external-docs read surface (THE-444).** Two read tools over a reserved,
  read-only docs-corpus vault, isolated from the private vault by a new `read:docs` scope
  and surfaced under a new `docs` facade domain:
  - `knowledge_search` — the docs-scoped analogue of `vault_graph_search`, reusing the
    contextual dense + BM25 + RRF graph retrieval bound to the corpus vault. No reranker,
    per the THE-441 re-adjudication (reranking lost decisively on the golden set).
  - `knowledge_get_critical` — a frontmatter `severity == "critical"` pre-filter: the
    breaking-changes / security / production-gotcha set to read before starting work,
    optionally narrowed to one source.

  Tool surface 141 → 143 (registry test + coherence gate + doc headlines in lockstep).
- **`services/docs-ingest`** — the ingestion scaffold for the docs corpus. A smart
  parse-router (Docling for PDF/Office, Firecrawl for web, passthrough for Markdown,
  unknown → Docling) feeding a LangExtract extraction interface and a writer that emits
  Markdown + frontmatter into the corpus vault the server indexes. Live backends are
  lazy-imported; `dry_run` exercises the route-to-write loop with no heavy deps. Live
  extraction and the crawl driver are a follow-up.

Security-audit follow-ups (external review of v1.10.0). No behavior change for a
correctly-configured deployment; these close residual seams and align the docs with
the code. The larger finding — folder-ACL enforcement being a per-handler convention
rather than a dispatch-pipeline stage — is tracked separately as its own change (#280)
because it is an architectural refactor, not a contained fix.

### Security

- **Two HIGH dev-dependency advisories closed, and the override that caused one of them bounded**
  (root + `docs/` `package.json`): `bun audit` reported `postcss <=8.5.17`
  (GHSA-r28c-9q8g-f849, path traversal in source-map auto-loading) in both workspaces, and
  `js-yaml >=5.0.0 <=5.2.1` (GHSA-pm4m-ph32-ghv5, exponential parse time in flow collections)
  at the root. Both are build/test-time only — `postcss` arrives via `vitest`/`astro`, `js-yaml`
  via `@napi-rs/cli` — so no shipped artifact was affected.

  The `js-yaml` finding was self-inflicted: the root override read `">=4.3.0"` with **no upper
  bound**, and an unbounded override does not merely permit a newer major, it *forces* every
  dependent onto it — dragging `@napi-rs/cli` (which declares `^4.2.0`) across a major boundary
  into the vulnerable 5.x line. The advisory's range starts at 5.0.0, so the fix is to stop
  hoisting rather than to chase the patch: the root override is now `">=4.3.0 <5"`, matching what
  the `docs/` workspace already had, and resolution returns to 4.3.0. `postcss` is pinned
  `">=8.5.18 <9"` in **both** workspaces — `docs/` carries its own lockfile and is not covered by
  a root audit, so an override added only at the root would have left it exposed.

  Both workspaces now report `No vulnerabilities found`. Verified beyond the audit: docs site
  builds, the native `napi` build (the actual `js-yaml` consumer) compiles, typecheck + lint clean,
  1901 server tests pass.
- **Per-caller ownership of retrieval feedback** (`migrations/20260724_001_chunk_retrievals_caller.sql`,
  `experiential/log.ts`, `tools/m8/experiential-tools.ts`; THE-568, closing the P1.7 follow-up):
  `chunk_retrievals` carried only `session_id`, so `record_retrieval_feedback` could only scope
  a non-elevated caller to a *session* — a caller who knew a foreign `session_id` could stamp
  that session's feedback/outcome regardless of who actually produced the retrieval. The table
  now carries a `caller` column, stamped by the retrieval logger at every serve-path call site
  (`search_text`/`search_vault` semantic mode, `vault_context`, `vault_graph_search`, `reflect`,
  `knowledge_search`, `knowledge_challenge`); `record_retrieval_feedback` adds an
  `AND caller IS ?` ownership predicate to its UPDATE (mirroring the `agent_episodes` /
  `work_forget` pattern) on top of the existing session scoping, so a non-elevated caller may
  only stamp retrievals it caused itself. `admin:workspace` crosses both. Zero blast radius on
  single-principal deployments; pre-migration rows with a `NULL` caller are simply unclaimable
  by a non-elevated caller (fail closed), same as an unknown id.
- **Experiential poison scanner canonicalizes before matching** (`experiential/poison.ts`):
  NFKC-normalize + strip zero-width/bidi controls before the content families run, so
  homoglyph (fullwidth "ｉｇｎｏｒｅ") and interleaved-invisible ("i​gnore … instructions")
  evasion folds into the existing patterns instead of slipping the scan. ASCII payloads are
  unchanged by normalization, so the red-team corpus stays at 100% with a 0 false-positive
  floor; new regression cases cover the evasion classes. Layer 1 remains a
  precision-leaning pattern scanner, not a complete filter (now documented as such in
  SECURITY.md) — the eligibility contract + reader trust floor are the real guarantee.
- **Prompts run through governance** (`mcp/server.ts`): `prompts/list` and `prompts/get`
  were the last MCP surface bypassing `ToolRegistry` entirely (no rate limit, no audit row).
  They now route through `dispatchResource` like resources did after THE-415 — throttle +
  audit + metrics — with `[]` scopes, so the open static-template semantics are preserved
  while "every invocation is audited" holds for the prompt surface too.
- **Constant-time bearer comparison in the bge-m3 embedding service**
  (`services/bge-m3-service`): the auth check used `!=` on the bearer string, leaking
  match length by timing; it now uses `hmac.compare_digest`.
- **qwen-tei helper binds loopback by default** (`services/qwen-tei/run.sh`): TEI has no
  auth, so the publish now defaults to `127.0.0.1` (override `BIND_HOST=0.0.0.0` behind a
  trusted network) instead of exposing the embedding backend on all interfaces.
- **Table-identifier allowlist on `countRows`** (`tools/m1/registry-tools.ts`): the one
  interpolated SQL identifier (always the literal `"chunks"`) is now gated on a fixed
  allowlist — defense-in-depth against a future caller ever forwarding one.
- **Folder-ACL enforcement is now a dispatch-pipeline stage, not a per-handler convention**
  (THE-414): tools declare the vault paths they touch via a `pathAcl` extractor on
  `ToolDefinition`, and `registry.runDispatch` enforces the folder ACL (the same
  symlink-canonical `enforcePathAcl`) for every declared path right before the handler — so
  containment no longer depends on each of ~120 handler call sites remembering to gate. This
  closes the "a handler forgot to gate" class that produced the v1.9.1 `strictReadDefault`
  regression (silently ignored in 8 tool files). Handler-side `enforcePathAcl` stays as
  defense-in-depth; paths a handler computes at runtime (backlink-rewrite targets, periodic
  resolvers, entity/session paths) remain handler-enforced and are documented exemptions. A
  guarantee test (`acl-extraction-coverage`) fails CI if any mutating tool declares neither an
  extractor nor an exemption, plus a test proves the central gate denies even when the handler
  never calls `enforcePathAcl`. The "central pipeline, folder ACL is a stage" claim in the
  README/ARCHITECTURE is now literally true.
- **Pinned the gitleaks scanner image to an immutable digest** (`ci-security.yml`; THE-426):
  the secret-scan job ran `ghcr.io/gitleaks/gitleaks:latest`; it now pins the `@sha256:` digest
  (refresh instructions in-line). Completes the supply-chain SHA-pinning pass (GitHub Actions
  were pinned in #272).
- **Namespaced the derived-cognition plane** (`migrations/20260724_001_plane_vault_id.sql`,
  `plane/jobs/{contradiction,synthesis}.ts`; THE-563): `contradictions` and `syntheses` carried
  no `vault_id`, so a weekly synthesis blended every vault into one record and path-equal notes
  in different vaults collided on the contradiction readers. Both tables now carry `vault_id`
  (contradiction dedup index re-scoped to `(vault_id, source_content_sha, conflict_content_sha)`;
  `syntheses` PK `(vault_id, iso_year, iso_week)`), the detector folds `vault_id` into the row id,
  and `runSynthesis` runs per vault. Following THE-310's `vault_edges` precedent the migration
  **purges** the unscoped rows (regenerable derived caches with unrecoverable historical vault)
  rather than backfilling a guess. Extends the vault-isolation invariant THE-310 established.
- **All-source ACL on derived objects before return / model egress** (`tools/m7/knowledge-tools.ts`,
  `experiential/forget.ts`; THE-564): a contradiction row exposed — and could send to the inference
  gateway — both contributing sources plus a rationale after checking only the caller-supplied
  side, so the opposite side could sit outside the caller's readable set. `openContradictionsForPaths`
  now drops any row where *either* `source_path` or `conflict_path` is unreadable, at all four call
  sites including the model-egress paths (`knowledge_challenge`, `reflect` challenge-mode) — the
  vault predicate (THE-563) is the first gate, per-path ACL (the THE-543 recheck pattern) the second.
  Also scoped `forget.ts`'s dependency-mention counts to the caller's vault. Syntheses (whole-vault
  aggregates with no per-source list) remain vault-predicate-gated, a documented boundary.
- **Per-path rule-scopes are now enforced** (`vault/acl-path.ts`, `mcp/registry.ts`,
  `tools/m6/admin-tools.ts`, `mcp/resources.ts`; audit P1.4): `acl.rules[].scopes` / `acl.defaultScopes` were computed
  by `scopesForPath` but only fed the cache fingerprint and the `inspect_acl` display — the config
  shape implied a per-path authorization dimension the code never enforced. They are now
  load-bearing (Require semantics): a caller must hold every scope a matching rule declares, on top
  of the tool's own required scopes, to operate on that path. Enforced centrally at dispatch (on the
  symlink-resolved path, so an in-vault symlink can't dodge a scope-gated target). The MCP
  `resources/read` content endpoint honors the same gate (it reads the same bytes as `read_note`, so
  it must not be a bypass); `inspect_acl` applies the same check (`denied_by: "path_scope"`) so the
  diagnostic can't drift from enforcement.
  Empty rule/default scopes add no requirement, so no shipped or live config changes behavior. The
  config docs/schema were reframed from the misleading "scopes granted to a path" to "required".
  Boundary: enforcement covers every tool that declares its paths via a `pathAcl` extractor (the
  central dispatch stage) plus the `resources/read` content endpoint. One surface remains folder-ACL
  only and is a tracked follow-up: search/enumeration *result visibility* (`readableRel`, governed by
  `readPaths`). The periodic-note and memory-entity tools, whose fs access was gated only
  handler-side with no rule-scope check, are closed by THE-567 below.
- **Rule-scopes now reach the periodic-note and memory-entity tools** (`tools/m3/periodic-tools.ts`,
  `tools/m5/memory-tools.ts`, `memory/materialize.ts`; THE-567, closing the P1.4 boundary above):
  `create_periodic_note`, `find_or_create_periodic_note`, `append_to_periodic_note`, `create_entity`,
  `add_observation`, and `link_entities` compute their real vault path from server config (the
  periodic-notes resolver; the memory folder) rather than caller input, so P1.4's central `pathAcl`
  dispatch stage — which only ever sees parsed input — could not reach them; they were folder-ACL
  gated but NOT rule-scope gated. `create_periodic_note`'s `template_override` (which *does* arrive
  verbatim in input) now has a `pathAcl` extractor and is centrally enforced like any other declared
  path. Every other config-computed path in these six tools now threads the caller's granted scopes
  into its existing handler-side `enforcePathAcl` call, so the rule-scope gate applies there instead
  of being silently skipped. Zero behavior change for a config with no rule-scopes (the shipped
  default); a caller lacking a rule-scoped folder's scope is now denied instead of allowed.
- **Experiential caller-partition is now an authorization boundary, not a default filter**
  (`tools/m8/experiential-tools.ts`; audit P1.7): the per-principal partition on the work-memory
  tools could be crossed at will — `work_search`/`work_episodes` `any_caller: true` needed only
  `read:workspace`, `work_forget` tombstoned any episode id with no ownership check, and
  `record_retrieval_feedback` stamped outcomes across sessions. Crossing the partition now requires
  an elevated `admin:workspace` scope: `any_caller` is forbidden without it; `work_forget` scopes its
  UPDATE to the caller's own episodes (a foreign/unknown id is a silent no-op — no existence oracle)
  unless elevated; feedback is scoped to a session (the given `session_id` or the caller's active
  session), and an unscoped cross-session stamp requires the scope. Zero blast radius on
  single-principal deployments. Boundary: `chunk_retrievals` carries no caller column, so feedback
  ownership is enforced at session granularity, not per-caller — a true per-caller feedback owner
  needs a schema column (tracked as a THE-230 follow-up).
- **Vault isolation `kind` is now a code-enforced property** (`config.schema.ts`, `vault/registry.ts`,
  `tools/m7/knowledge-tools.ts`; audit P1.5): the `read:docs` surface (`knowledge_search`,
  `knowledge_get_critical`) resolved *any* vault id, so docs/private isolation rested on token
  provisioning + naming rather than a property — a misprovisioned docs token could read the private
  vault. Vaults gain a `kind: private | docs | system` config field (default `private`), and the docs
  tools refuse any vault whose kind is not `docs` (forbidden), so the read:docs surface is code-bound
  to the docs corpus. `add_vault` accepts an optional `kind`; `list_vaults` surfaces it. Zero blast
  radius: all existing vaults default to `private`, and a docs corpus is opt-in. Boundary at the time:
  enforcement was one-directional — the private `read:notes` tools (`vault_graph_search`, `read_note`,
  `write_note`, …) were not fenced OUT of a `docs`/`system` vault, so a docs corpus was read-only by
  convention, not by kind. The reverse (write/integrity) direction is now closed by THE-569, below.
- **Reverse vault-kind gate: mutation of a docs/system vault is now refused (THE-569, closing the
  P1.5 boundary above)** (`mcp/registry.ts`, `cli.ts`): P1.5 closed the read direction only — a
  misprovisioned `write:notes`/`delete:notes`/etc. caller could still resolve a `docs`- or
  `system`-kind vault by id and mutate it, since the private note tools apply no `kind` check. A
  new central dispatch gate (parallel to the existing `rootResolver`/`aclResolver` stages, keyed on
  the same mutating-scope signal `runDispatch` already computes for the read-only-ACL check) now
  refuses any mutating call — `destructive: true` or a required scope in the `write`/`delete`/
  `bulk`/`execute` family — whose effective vault (`input.vault ?? ctx.vaultId`) resolves to `docs`
  or `system`. Read calls on a docs/system vault are unaffected; this closes only the write/integrity
  direction. No per-tool annotation needed — reuses the existing mutating-scope classification, so
  every current and future write/delete/bulk/execute tool is covered automatically. Zero blast radius
  for the default all-`private` config (the gate no-ops with no `vaultKindResolver` wired, e.g. the
  `prefetch` CLI's standalone registry).

### Fixed

- **No keyed handler duplicates user data on retry** (THE-572, closing the residual #13
  documented but could not reach from the dispatch layer): #13 marks an idempotency claim
  `effect_committed` only when the whole handler *returns*, so a handler that committed effect #1
  and then did more fallible work still had a real window — a throw before the return deleted the
  claim and a retry **re-ran the handler**. Two keyed handlers duplicated user data outright:
  `add_observation` (SQLite append, then note re-materialize) appended the observation twice, and
  `append_note` / `append_to_periodic_note` (note write, then a post-write step) concatenated the
  content twice. Others corrupted bookkeeping rather than content — `start_session` inserted a
  second session row, `enqueue_capture` a second queue row, `write_note`/`copy_note` a second
  snapshot-ledger row consuming a retention slot — and `move_note`, `move_attachment` and
  `bulk_move_notes` answered a retry with `note_not_found` (or a wholly-failed batch) about the
  caller's *own* prior attempt. The fix is two-part:
  - **`ctx.markEffectCommitted()`** — a mid-execution signal that moves the marker to the
    handler's own first durable effect. Deliberately write-ahead: it can only over-report (a
    caller told to verify state when nothing in fact applied), never under-report a silent
    double-apply. The dispatch catch consults the **durable** claim state rather than the
    in-memory flag, so a signal rolled back with the handler's transaction still releases the
    claim for a real retry.
  - **Per-handler ordering/atomicity.** Where both effects are `ctx.db` writes — `add_observation`,
    `start_session`, `enqueue_capture` — the marker joins them in one transaction via a new
    `inTransaction` helper, so the effect and the claim either both land or neither does. Where the
    second effect is a *filesystem* write, no transaction can span it, so `add_observation` instead
    runs its **idempotent** effect first (a full-note overwrite, byte-identical on a re-run) and
    commits the SQLite side after.

  The heading says **user data** deliberately, and the scope is worth stating exactly. What is
  closed: no keyed handler appends, inserts or rewrites *caller content* twice on a retry. What is
  not: two handlers can still leave duplicate **bookkeeping** behind. `start_session` writes its
  JSONL trace before the row, so each failed attempt leaves an orphan trace file — unique per
  attempt, so never mistaken for a duplicate, and first-party readers are row-first and ignore it,
  but not idempotent. `bulk_create_notes` signals before its first worker, which bounds a crash
  mid-batch to a re-written file rather than a re-run batch, but its `overwrite`/`upsert` items are
  not individually idempotent.

  The other limit is the cost of ordering-first. `add_observation` renders the note from the state
  it is about to commit, so the projection can drift from SQLite — and under two *concurrent* calls
  it can end up **behind** it (both render from the same base, the last writer wins the file while
  both appends commit). Nothing schedules reconciliation: the note is corrected only when something
  later happens to rematerialize that entity, which may be never. SQLite remains the source of
  truth and every read path uses it, so this is a stale *projection*, not lost data — but it is not
  self-healing, and calling it that would be wrong.

  Also reconciles the #13 prose, which named a keyed-tool set that was never verified against the
  schemas. `extractIdempotencyKey` reads a top-level `idempotency_key`, the `bulk_idempotency_key`
  alias, **or a nested `options.idempotency_key`** — and every tool taking `WriteOptions` carries
  the nested one, which is easy to miss by grep. The full keyed set is `add_observation`,
  `enqueue_capture`, `start_session`, `create_periodic_note`, `append_to_periodic_note`,
  `bulk_create_notes`, `bulk_move_notes`, `write_note`, `append_note`, `move_note`, `copy_note`,
  `move_attachment`, `create_canvas` and `create_base` — **not** `commit_capture`, `link_entities`
  or `bulk_set_property`, which the #13 prose named but which never entered this pipeline.
- **At-most-once idempotency under post-effect faults** (THE-562 #13, closing the THE-413 residual):
  the dispatch pipeline deleted an idempotency claim on any failure *after* the handler had already
  committed its side effect (a strict-output-schema violation, a `JSON.stringify` failure on the
  payload, or an overflow-finalize fault), so a retry with the same key re-ran the handler and
  double-committed. The claim now advances through an explicit `state`
  (`in_flight → effect_committed → completed | indeterminate`): a post-effect fault records
  `indeterminate` instead of deleting, and a retry returns a typed `indeterminate_outcome` error
  rather than re-executing. A process crash after the effect is likewise honored on reclaim. The
  marker is set when the handler returns, so the residual window — a crash **or an in-process throw
  between a handler's first external effect and that return** (e.g. a multi-step handler that commits
  then does more fallible work) — is pre-existing, unchanged by this fix, and irreducible at the
  dispatch layer without atomic/idempotent handlers; it is documented at the call site.

### Changed

- **Background workloads run on the durable `JobQueue`** (THE-562 #14, extends THE-517): the
  contradiction-detection and plane-consolidation (synthesis + audit) workloads were driven by an
  in-memory queue that silently dropped work under backpressure and a bespoke timer that let a run
  vanish on a transient gateway failure. Both now enqueue durable jobs drained by one generic runner
  (`scheduler/job-runner.ts`) on the shared scheduler, so their work is crash-safe, leased,
  retryable, and dead-letterable. Contradiction jobs retry up to 3× with a content-sensitive
  idempotency key (`vault:chunk:contentHash`, so re-editing a note re-judges it rather than being
  deduped against a stale completed job); synthesis/audit run once per cycle and dead-letter
  immediately on failure (they regenerate next cycle) — a non-throwing `{ ok: false }` from
  `runSynthesis` now surfaces as a dead-letter instead of being marked complete. `server_health`
  gains a `job_queue` block (queued / running / retrying / failed + oldest-queued age) so backlog and
  persistently-failing workloads are visible. Closes the `job-queue.ts` "not yet wired to a workload"
  reachability-allowlist entry.
- **Recurrence guards for the release process** (THE-426): a `tsc` gate now runs at the top of
  `scripts/release.mjs` (shared build + server typecheck) so a type error that vitest/esbuild
  accept can never reach a published tag; and a scheduled `release-lag` workflow
  (`scripts/check-release-lag.mjs`) goes red when `main` drifts past a threshold ahead of the
  latest tag while carrying unreleased Fixed/Security CHANGELOG entries — the THE-285 pattern
  where critical fixes sat unshipped. Advisory (a scheduled nag), not a per-PR gate.
- **`reflect.persist` writes through the governed note-write service** (`vault/persist-note.ts`,
  `tools/m7/knowledge-tools.ts`; audit P1.6): the derived-reflection write used a raw `writeFileSync`,
  bypassing the snapshot, atomic tmp+rename, and index-on-write/generation bump — so a same-query
  same-day reflection silently overwrote its predecessor with no recovery point and left the note
  unindexed. It now shares one `persistGovernedNote` helper with `write_note`, so the two write paths
  cannot drift.
- **Single migration manifest + completeness gate** (`db/migration-manifest.ts`; audit #9): the
  cache.db and experiential.db chains were hand-enumerated in two files, so a `.sql` wired into
  neither chain silently never ran. Both chains now build from one manifest, and a CI bijection test
  fails when a migration file on disk is registered in neither chain.

### Documentation

- **Reconciled the retrieval-quality numbers** (`README.md`): the headline
  nDCG/recall/bridge figures were stated as fact in one place and "pending (THE-296)" in
  another. They are now labeled **provisional** — reproducible only against the private
  (not-checked-in) golden set and pending a live-backend re-run — while the statistical
  ship-rule *machinery* (unit-tested in CI) is what the repo actually ships.
- **Foregrounded the zero-config security posture** (`README.md`): made explicit that
  `obsidian-tc /path/to/vault` boots with auth off and no folder ACL (governance is
  opt-in), safe because the config fail-closes any non-loopback unauthenticated bind.
- **Documented the learned-state namespace model** (`SECURITY.md`,
  `experiential/reflect.ts`; audit P1.8): obsidian-tc's adaptive state is deliberately mixed —
  `agent_episodes` is per-principal (vault+caller+session, P1.7-authorized), `chunk_retrievals` and
  `vault_object_state` ACT-R activation are content/corpus-level by design (a relevance signal about a
  chunk, not a principal — per-caller would fragment it), and `preference_profile` is a single global
  runtime store. A new *Learned-state namespaces* table in SECURITY.md makes the intended scope of
  every store explicit, and the `preference_profile` global scope is recorded as an accepted
  single-user residual (per-caller preference isolation is a multi-principal follow-up). No behavior
  change.

### Performance

- **Cache the indexer reconcile-path statements** (`search/indexer.ts`, `search/vec.ts`;
  THE-316): `applyNoteWrites`, `upsertVec`, and `deindexNote` compiled their static-arity SQL
  with raw `db.prepare(...)` on every note and every re-embedded chunk. Under `bun:sqlite`
  (the production runtime) `db.prepare` is uncached, so a 100-note flush recompiled ~500+
  statements. These paths now use `cachedPrepare(db, sql)` (memoized by SQL text, already the
  sanctioned mechanism for the audit/idempotency hot paths), collapsing the recompiles to a
  handful for the process lifetime. Biggest win on warm `index_vault`. No behavior or schema
  change; dynamic-arity queries stay on plain `prepare`.

### Included pull requests

The narrative sections above cover the changes that alter behaviour or contracts. This is the
complete manifest of the 95 user-visible pull requests in `v1.10.0..HEAD`, so nothing in a
136-commit release is silently absent from the notes — which is exactly what the release gate in
`scripts/release.mjs` exists to prevent.

- #277 — feat(release): fail the cut when a user-visible PR has no CHANGELOG entry
- #281 — fix(security): audit follow-ups — poison canonicalization, prompt governance, service hardening
- #282 — perf(indexer): cache reconcile-path statements with cachedPrepare (THE-316)
- #283 — feat(dispatch): make folder-ACL a dispatch-pipeline stage via declarative path extraction (THE-414)
- #286 — fix(facade): map vault_context to the knowledge domain
- #287 — feat(docs): vendor/external-docs read surface (knowledge_search + knowledge_get_critical)
- #288 — feat(ingest): docs-ingest scaffold with a Docling/Firecrawl parse-router
- #291 — fix(links): treat escaped pipe (\|) as the wikilink alias separator
- #296 — feat(indexer): two-tier content_hash / body_sha cross-path embedding dedup
- #298 — feat(eval): failure taxonomy + BFS reachability probe (eval-only)
- #297 — feat(ranking): config-driven frontmatter metadata prior (authority boost), off by default
- #295 — feat(search): off-by-default bubble-safe activation composition (THE-233)
- #293 — fix(indexer): GC contradiction flags when a chunk is pruned or re-embedded (#280-followup)
- #300 — feat(eval): --diagnose wires the failure classifier into runEval (THE-446)
- #299 — feat(indexer): cross-run body_sha dedup — seed the registry from the persisted column (THE-445)
- #301 — feat(search): pre-plumb bubble-safe on the default graph_rrf/convex path, strictly off (THE-447)
- #304 — fix(acl): resolve per-vault ACL at indexing time (THE-453)
- #305 — fix(auth): bind JWT audience/issuer for remote/JWKS deployments (THE-456)
- #306 — fix(indexer): serialize index-on-write per (vault,path) (THE-455)
- #307 — fix(indexer): copy the vector for cross-path dedup chunks (THE-454)
- #308 — fix(search): rebuild vec index on an embedding-dimension change (THE-457)
- #309 — fix(plane): single-flight guard on the scheduler (THE-457)
- #310 — fix(mcp): optional strict output-schema enforcement (THE-457)
- #311 — fix(cli): continuous contradiction drain + graceful shutdown (THE-457)
- #312 — fix: hygiene — audit-write health + remove stale biome suppressions (THE-457)
- #314 — feat(docgen): config extractor — walk the Zod schema into ConfigDoc[] (THE-471)
- #315 — feat(docgen): tools extractor — full registered surface → ToolDoc[] (THE-471)
- #316 — feat(docgen): renderers + render CLI — model → wiki pages (THE-472)
- #318 — feat(docgen): Astro docs-site integration (THE-474)
- #319 — feat(docgen): metrics, errors + schema extractors (THE-471)
- #321 — feat(docgen): advisory LLM prose suggestion tool (THE-477)
- #329 — feat(index): complete the vec-index fingerprint beyond dimension (THE-460)
- #327 — fix(security): second-pass audit remediation — read-ACL on write, enrichment-safe dedup, auth/index/plane hardening
- #331 — build(docs): upgrade Astro 6→7 + Starlight 0.39→0.41 (THE-498)
- #333 — build(deps): clear the Hono/fast-uri advisories (7 -> 0)
- #332 — fix(acl): stop FolderAcl handing out live config references + bound glob length
- #334 — build(docs): clear the docs-workspace advisories + audit that workspace in CI
- #335 — perf(acl): read the whitelist once in the index-time visibility predicate
- #336 — feat(auth): typed rejection reasons + auth_rejections_total (THE-520)
- #340 — fix(scheduler): apply backoff to the in-memory schedule + honour the AbortSignal (THE-462)
- #341 — fix(vec): filter the rebuild backfill by model, not just dimension (THE-460)
- #342 — fix(perf): report peak RSS honestly instead of extrapolating per 10k chunks (THE-459)
- #343 — feat(perf): HTTP cold/warm handshake collector, family 12 (THE-495)
- #345 — build(release): pin model-service CI deps by hash + report unsigned release tags (THE-528)
- #347 — perf(db): composite dedup index on (vault_id, body_sha, content_hash) (THE-502)
- #348 — perf(indexer): memoize the schema-shape probes per connection (THE-491 item 1)
- #350 — feat(eval): per-category metric slices (THE-449 remaining criterion)
- #354 — feat(capability): environment detection — Obsidian, vaults, plugins, hardware (THE-522)
- #355 — feat(doctor): runtime-health command with a machine-readable report (THE-521)
- #356 — feat(bridge): version handshake + bridge.state + compat matrix (THE-523)
- #357 — feat(tools): refresh_plugin_capabilities — re-probe without restart (THE-527)
- #358 — fix(retrieval): brute-force fallback must filter by active model (THE-530)
- #359 — fix(indexer): re-embed on model swap + deactivate superseded rows (THE-531)
- #360 — feat(config): securityProfile "hardened" — one key for the least-privilege posture (THE-526)
- #361 — perf(indexer): density-aware embed token estimate to cut bisection retries (THE-487)
- #362 — feat(retrieval): stamp note freshness (age_days + stale) on hits (THE-450)
- #363 — perf(indexer): aggregate dedup logging instead of per-duplicate stderr (THE-499)
- #364 — perf(indexer): bulk-load chunk state once per reconcile, not per note (THE-501)
- #365 — perf(indexer): byte-bounded, configurable batch transactions (THE-500)
- #366 — perf(indexer): memoize dedup-vector lookups within a flush batch (THE-488)
- #367 — perf(activation): incremental recompute past a watermark, not a full-log rescan (THE-461)
- #368 — perf(mcp): cache immutable catalog products + extend serialization memo (THE-463)
- #369 — feat(cache): vault-generation counter + ACL fingerprint (THE-496)
- #370 — feat(retrieval): multi-query fan-out fusion engine (THE-448)
- #371 — feat(retrieval): agent-supplied HyDE on vault_graph_search (THE-451)
- #373 — perf(search): delta-only derived-edge densification (THE-486)
- #374 — feat(search): opt-in streaming vault walk for indexVault (THE-490)
- #375 — perf(native): optimize cosine_batch — precomputed query norm, single-pass docs (THE-504)
- #376 — perf(harness): subprocess isolation, contention detection, statistics (THE-503)
- #377 — feat(scheduler): durable job queue with leases and crash recovery (THE-517)
- #379 — fix(retrieval): expose adaptive RRF as config + correct the inert activationRerank description (THE-536, THE-535)
- #382 — feat: get_index_status + list_contradictions reader tools (THE-491)
- #383 — fix(security): bind the vault_context prewarm cache to the caller's ACL (THE-543)
- #385 — fix: replace literal NUL bytes in source with escapes + guard (#378)
- #387 — fix(retrieval): thread every config knob to all four graphSearch sites (THE-545)
- #388 — fix(ci): pass install-mode through env, not run: interpolation (THE-541)
- #389 — fix(scheduler): observe lost leases instead of discarding them (THE-517)
- #390 — fix(capability): bound the hardware enricher so its degrade path can run
- #394 — feat(eval): persistent run history with corpus provenance (THE-560)
- #395 — fix(http): serve natively under Bun to stop keep-alive connection drops (THE-561)
- #396 — fix: audit bucket-A — reflect.persist wildcard scope, prewarm invalidation, SECURITY version (THE-562)
- #397 — fix(experiential): hold known-bad-outcome episodes; state the promotion contract (THE-565)
- #398 — feat(docgen): narrative fact gate + reconcile drift to 146/n=250 + enforce (THE-566)
- #402 — fix(THE-562 tail): cross-platform npx in boundary check (#17) + disclose bm25_weight caveat (#15)
- #403 — feat(THE-562 P1.4): enforce per-path rule-scopes at the central dispatch ACL stage
- #404 — feat(THE-562 P1.7): make the experiential caller-partition an authorization boundary
- #405 — feat(THE-562 P1.5): code-enforce vault isolation kind (private|docs|system)
- #407 — feat(THE-562 #16): surface retrieval-head readiness independently in doctor
- #408 — feat(THE-562 #14): wire the durable JobQueue to its workloads
- #409 — feat(THE-562 #13): durable idempotency claim state-machine
- #410 — feat(THE-562): thread rule-scopes into periodic + memory tool paths
- #411 — feat(THE-562): per-caller ownership of retrieval feedback
- #412 — feat(THE-562): reverse vault-kind gate — reject mutation of docs/system vaults (THE-569)
- #415 — fix(deps): close 2 HIGH bun-audit advisories; bound the js-yaml override
- #413 — fix(THE-562): close the intra-handler idempotency window (THE-572)

## [1.10.0] - 2026-07-17

Minor rather than patch because nothing here is dark: unlike v1.9.1's additions
(all off by default), every change below is live for an existing user on default
config.

### Fixed

- **npm did not ship SKILLS.md (affects v1.9.1 and earlier)** (#270): the agent
  onboarding guide lives at the repo root, which belongs to the unpublished
  `obsidian-tc-monorepo` package, and npm's `files` cannot reference paths
  outside the package directory — so `files: [dist, README.md, LICENSE]` had no
  way to pick it up and it reached GitHub only. It is now vendored into
  `packages/server/` at build time (the same mechanism already used for the
  companion plugin) and listed in `files`. The repo root stays the single source
  of truth; the copy is generated and gitignored, so the two cannot drift.

### Security

- **Latent stale-plugin vendoring hazard closed** (#270): `copy-assets.mjs`
  rebuilt the companion plugin only when `dist/main.js` was ABSENT, so any build
  left over from before a version bump would be vendored verbatim into the
  tarball. **This never affected a published release** — `publish.yml` builds the
  plugin in a fresh checkout, where no stale `dist` exists, so CI always rebuilt
  it (verified: the published 1.9.1 tarball carries a correct 1.9.1 plugin). It
  bit local and developer builds only. The hazard is real regardless, and
  `check-version-coherence.mjs` could not have caught it: it asserts
  `packages/plugin/manifest.json` — the SOURCE, which was always correct — and
  nothing asserted the artifact that ships. The plugin is now always rebuilt
  before vendoring, the vendored manifest is asserted against the server version,
  and a failed vendor drops the directory rather than publishing a mismatch. A
  ci-install-smoke tarball guard packs for real and asserts the published bytes
  on all three OSes.
- **Every GitHub Action pinned to a full commit SHA** (#272): 83 of 89 `uses:`
  lines ran on mutable tags, so each workflow was one upstream retag away from
  running different code with our token. Two upstreams had already moved —
  `dtolnay/rust-toolchain@stable` had DIVERGED from the pinned sha, and
  `Swatinem/rust-cache@v2` was 1 ahead. Version drift reconciled onto the highest
  version already proven in-repo. `actions/upload-artifact` v4/v7 deliberately
  left un-reconciled (publish.yml runs a matched v4 upload/download pair).

### Added

- **Hardened deployment profile + startup security posture** (#269): a
  schema-valid least-privilege `examples/config.hardened.json`, and a
  `security: auth=… readOnly=… strictRead=… requireCas=… http=…` line written to
  **stderr on every startup**, with a warning when the permissive trusted-local
  defaults are active. Governed by default is not least-privilege by default.
- `obsidian_tc_audit_write_failed_total` (labels: `vault`, `tool`) — counts
  security-audit event writes that failed. Audit is fail-open by design (a failed
  write must never break dispatch), so the failure was previously silent and the
  audit trail could go lossy with no signal. Prometheus catalog is now 9 counters,
  2 histograms, 4 gauges. (THE-416)
- Ambient context capture: design spec plus macOS / Windows / Linux phase plans
  land as docs. Design only — no product code (THE-175).

### Changed

- **`resources/read` and `resources/list` are now rate-limited and audited**
  (THE-415, #273): both bypassed `ToolRegistry.dispatch` entirely. They were not
  unguarded — `resources.ts` enforced the `read:notes` scope, vault binding, the
  folder read-ACL, and path containment — but they escaped GOVERNANCE: the
  THE-210 limiter never saw them, so a `read:notes` caller could pull the whole
  vault in a loop with no budget, and no audit row was written. Both now route
  through `ToolRegistry.dispatchResource`, and dispatch's audit closure is
  extracted into one shared `recordOutcome()` so the two surfaces cannot drift
  again. **A heavy resource client that was previously ungoverned can now be
  throttled.**
## [1.9.1] - 2026-07-15

### Added

- **Graph densification (experimental, off by default)** (#250): derived edges
  added to the `vault_edges` graph beyond authored wikilinks — `shared_tag`
  (frontmatter tag co-occurrence), `similar_to` (vec0 kNN semantic neighbours, no
  egress), and `semantically_similar_to` (LLM Pass-3 via the local inference
  gateway, injection-defended, batch-only). The graph walk can optionally traverse
  them, down-weighted vs authored links. Governed by `retrieval.densify.*` (every
  flag off/conservative by default). Derived and rebuildable — never written back
  into notes as wikilinks; hub tags/nodes emit no edges. **Unmeasured and dark**:
  it ships behind flags pending a multi-hop golden-set A/B (the prior THE-135
  virtual-hop hit an 80% bridge-recall ceiling below the champion's 0.831), exactly
  like `retrieval.sparse` / `retrieval.colbert`. See
  `docs/plans/2026-07-13-graph-densification.md`.
- **Densify follow-ups** (#251): `index_vault` threads `retrieval.densify`
  (`tagEdges` / `knnEdges` build derived edges during indexing, full-state per
  kind), and a new `obsidian-tc densify-llm [path] [--vault id]` CLI runner builds
  the LLM Pass-3 `semantically_similar_to` layer via the local gateway (refuses if
  no gateway resolves). Both off by default.
- **Experiential activation recompute on the serve path** (#259): the ACT-R
  activation recompute now runs during `serve` (gated on capture, on the
  maintenance cadence), not only via the CLI, so cached activation scores stay
  fresh as retrieval logs accrue. `activationRerank` remains off by default.

### Fixed

- **Data-loss fix (affects v1.9.0): the FTS divergence repair deleted durable
  note metadata.** `ensureNotesFts` treated an empty or absent derived
  `notes_fts` index as authoritative and ran `DELETE FROM notes` (the durable
  table). Reachable without corruption via the supported `OBSIDIAN_TC_DISABLE_FTS=1`
  flag (or a swallowed FTS error): one run leaves `notes` populated and
  `notes_fts` empty or absent, and the next wipes note metadata (on the
  single-note index path, one file save wiped the vault and re-added one row),
  silently degrading FTS/lexical search until a full re-index. The repair now only
  prunes FTS orphans and blanks the stale `content_hash`; it never deletes from
  `notes`.
- **Read-ACL: `strictReadDefault` was ignored in 8 tool files (affects v1.9.0).**
  Consolidated to a single read-ACL predicate so `strictReadDefault` is honored
  uniformly across the frontmatter / graph-health / links / notes / tags / index /
  search / base / canvas / kanban / periodic / tasks / knowledge read tools; added
  ACL single-source and enumeration regression tests.
- **Idempotency post-effect retry no longer re-executes a committed side effect.**
  When a keyed write's response exceeded the byte budget, the claim was deleted, so
  a retry with the same key re-ran the already-committed effect. The claim is now
  finalized with the terminal overflow outcome and the replay path re-checks the
  budget, so a retry replays the overflow error instead of re-executing.
- **Built-CLI asset resolution** (in the bundle, not source): the migrations
  directory and cache provisioning now resolve against the built `dist` bundle, so
  the shipped CLI boots. The regression was invisible to the source tests and caught
  only by the install-smoke.
- **ReDoS in the vault-leak guard's path regex** removed (`js/redos`).
- **BGE-M3 reranker `device="auto"`** is resolved to cuda/cpu before
  `CrossEncoder` (sentence-transformers 5.x passes device straight to
  `torch.to()`, which rejects "auto"), so the optional service loads its reranker
  under default config (#263).
- **Config off-switches**: `retrieval.densify.llmEdges` is now a real off-switch,
  and four keys that gated nothing were removed.
- Doc coherence: the README comparison-table tool count (`~123` to 141) is now
  covered by the version-coherence gate.
- **Graph densification correctness hardening** (external audit of the first cut;
  all in the dark, unreleased feature — no v1.9.0 behaviour changes): a failed
  gateway run no longer erases the LLM edge layer (`extractSemanticEdges` reports
  `failedBatches`; the runner refuses to reconcile a partial run); turning
  `tagEdges` / `knnEdges` off now actually prunes those edges (the reconcile runs
  every pass with an empty desired set, instead of being gated behind the flag);
  derived edges are upserted so a changed confidence / fingerprint refreshes
  instead of being silently kept stale; an authored (literal) edge now wins an
  equal-hop tie in the walk, so a wikilinked note is never mislabelled derived and
  down-weighted; the LLM runner orders notes by path for deterministic batching;
  and the edge fingerprint covers both endpoints rather than the alphabetically
  first one. Two doc overclaims corrected: the fingerprint does not "self-flag
  stale" (no sweep exists yet), and the prompt-injection wrapping is
  defense-in-depth, not a guarantee of inertness — the output contract (known
  paths + discrete confidences) is the real blast-radius limit.

### Security

- **Repository vault-data containment.** The multi-hop golden set is private vault
  data and is no longer committed (moved out of the repo); a CI guard now rejects
  vault data (databases, golden-set shapes, known vault paths) before it can land;
  and a real vault path that a merge brought onto `main` was scrubbed.

### Documentation

- **Agent onboarding guide** (`SKILLS.md`, #265): a working guide for AI agents and
  the humans configuring them, covering the governance mental model, setup and the
  companion plugin, the find/describe/call discovery loop, a capability map by
  intent, the genuinely new features, safe-operation rules, agent playbooks, an
  example vault-convention set, and a config quick reference.

## [1.9.0] - 2026-07-13

### Added

- **Polyglot model tier** behind the `ModelClient` boundary (#239, #245, #246,
  #247), all **off by default** (no behavior change unless configured).
  `embeddings.provider: "model-tier"` serves dense retrieval from **Qwen3 via
  HuggingFace TEI** (`services/qwen-tei`) and **BGE-M3 multi-vector** (dense +
  learned-sparse + ColBERT, one `/v1/encode`) via the Python
  `services/bge-m3-service`, fused as SEPARATE RRF streams (never adding a Qwen
  cosine to a BGE score). Serve-path `retrieval.sparse`, `retrieval.colbert`,
  and a live `bge-reranker-v2-m3` cross-encoder are wired through the search
  Reranker seam — all gated off, pending a golden-set measure on your vault.
- **Native batched cosine** `cosineBatch` (#238, THE-420): one N-API crossing
  per query on the brute-force fallback path (~2.8x over the JS implementation),
  shipping with the repo's first benchmark harness.
- **Model-service and security CI, plus a Python test suite** (#248): a 16-test
  pytest suite for `services/bge-m3-service` (mock model layer, no torch/GPU); a
  path-filtered `ci-model-service` workflow (ruff + py_compile + pytest); and
  `ci-security` (a gitleaks gate over the working tree + cargo-audit + bun-audit,
  with a weekly cron).

### Fixed

- **v1.8.1 code audit — 13 fixes** across security, correctness, and robustness
  (#244): the bge-m3 bare-`catch` that disabled sparse/ColBERT on any transient
  error, the `/excalidraw/write` empty-scaffold overwrite data-loss, the
  gatedRerank absolute-cosine no-op, and the MMR-under-cluster-cap no-op; plus a
  reranker z-margin gate, atomic `forget`, vec dim-mismatch recording, and
  companion-plugin robustness.
- **Dispatch hardening** (#236): redact the HITL token from telemetry; warn on
  output-schema drift.

### Changed

- **Rust/Python/TS workload-partition ADR** and build order (#237): partition by
  compute profile — Rust for batched CPU kernels, Python for GPU/ML behind the
  service boundary, TypeScript for the control plane.
- Docs freshness pass and duplicate-stale-claim fixes (#234, #235).
- The model tier is **optional**: the server runs unchanged without the services
  (dense-only, existing providers). If you enable it, pin `BGE_MODEL_REVISION`
  and the TEI model image, and measure the new retrieval streams on your golden
  set before turning any of them on.

## [1.8.1] - 2026-07-12

### Fixed

- **bge-m3 sparse vectors are now reference-correct** (derived token/score
  alignment + special-token filtering). Two defects corrupted every stored sparse
  vector: vLLM's BgeM3 pooler strips BOS/EOS from `token_classify` scores while
  `/tokenize` returns the full id list, and the positional pairing silently
  truncated the mismatch — shifting **every weight one token left** — while
  cls/eos/pad/unk weights were never filtered per the FlagEmbedding
  `lexical_weights` contract. Alignment is now derived (equal lengths pair
  directly; a 2-short score list pairs against the inner ids; any other mismatch
  degrades the head to empty — never truncates), and XLM-R special ids are
  dropped. **If you built a bge-m3 sparse index with an earlier version, rebuild
  it** — the stored vectors are mis-keyed. Re-measured clean on the maintainer
  vault (n=136 paired): the sparse RRF stream is statistically zero on every
  metric vs the shipped BM25+dense+graph champion, so it remains off by default.

### Changed

- **The configuration reference is now complete** — every `ServerConfigSchema`
  field with its default (including previously undocumented `snapshots`,
  `bootstrap`, `writes.requireCas`, the embeddings batch/prefix knobs, HTTP
  DNS-rebinding options, the `bge-m3` provider, and `plur.command`), the full
  10-variable environment table, and a new **inference gateway** setup guide
  (self-hosted LiteLLM recipe, role→model policy, verification, degradation
  semantics) at `configuration/inference-gateway`.

## [1.8.0] - 2026-07-12

### Added

- **Obsidian Git + Remotely Save bridges (THE-378, THE-381).** Seven new M4
  companion-bridge tools (surface **141 across 31 domains**): `git_status`,
  `git_diff`, `git_log` (read; repo-wide surfaces fail closed under a read
  whitelist), `git_stage` (write, per-path ACL), and `git_commit`
  (`execute:git` — a hardcoded HITL floor, so commits always require human
  confirmation); plus `remotely_save_status` / `remotely_save_trigger`, an
  independent backup-verification signal. Agent git now flows through the
  ACL/HITL pipeline instead of shelling out; the plugin side duck-types
  obsidian-git's gitManager defensively (git failures degrade to `git_error`,
  never a 500) and `/probe` advertises both capabilities.
- **Dependency-aware deletion + hash-chained forget audit (THE-239).** New CLI
  `obsidian-tc forget [path] (--episode <id> | --note <rel-path>) [--erase]`,
  plus `--verify`. Episode forget tombstones always and scrubs content fields
  under `--erase` (the row skeleton keeps the attribution chain); note forget
  propagates an already-deleted note through the derived stores — retrieval
  history kept under the default tombstone/audit posture, deleted under
  `--erase`; derived activation cleared; a prewarm bundle mentioning the
  target invalidated; syntheses/contradictions/reflections reported, never
  rewritten. Every forget appends to `forget_log` (migration 20260712_003), a
  hash chain where editing, removing, or reordering any entry breaks
  verification.
- **Knowledge-gap detector (THE-48).** New CLI `obsidian-tc gaps [path]
  --queries <file> [--vault id] [--threshold T] [--min-results N] [--json
  file]` runs a batch of queries through the live engine and flags the ones
  with no real coverage — top-1 below the calibrated floor or too few results
  — with nearest-context paths for issue drafting. `--calibrate <golden.yaml>`
  replays the golden set and prints the top-1 score distribution; the shipped
  default threshold (0.138) is the measured p5 on the n=136 set against the
  live index (the original 0.75-cosine rule is meaningless on fused RRF
  scores). The cycle-close session files "Knowledge gap:" issues from the
  report; the server only detects.

- **Derive-don't-mutate access instrumentation + knowledge-health scorecard
  (THE-44, THE-46).** `chunk_access_stats` — a VIEW over `chunk_retrievals`
  (access count, last access, citations, outcome balance; migration
  20260712_002) — replaces the original mutate-the-chunk-store design, and the
  `linear:` frontmatter convention replaces a `linked_issue_id` column. New CLI
  `obsidian-tc metrics [path] [--vault id] [--since ms] [--until ms]
  [--stale-days N] [--json file]` emits the cycle scorecard (totals, windowed
  retrieval/citation counts, staleness cuts, linear-linked coverage,
  per-surface breakdown, top notes) for the cycle-close session to stamp into
  a vault metrics note.

### Changed

- **vec0 index: per-vault partition key + metadata aux columns (THE-277).**
  `vec_chunks` is now `vec0(chunk_id PK, vault_id partition key, +path, +model,
  embedding)`: KNN prunes to the query vault's shard (the cross-vault crowding
  class is structurally gone) and results carry their path without a join. A
  legacy-shaped table is detected at boot and rebuilt in place from stored
  `chunk_embeddings` — **no re-embed**.

### Fixed

- **`eval_dataview_field` no longer hangs to the bridge timeout.** The companion
  route passed the note *path* where Dataview's `evaluate()` expects a
  variable-context *object*; the rejected promise was uncaught, and LRA's express
  router leaves an unanswered request hanging. The route now builds its context
  from `dv.page(path)` (so `file.*` and frontmatter fields resolve inside the
  expression), maps a missing page to `note_not_found` and evaluation throws to
  `dql_error`. Systemically, **every companion route is now wrapped by a
  catch-all at the registration boundary** — a throwing/rejecting handler answers
  a typed `bridge_error` envelope instead of hanging its request until the
  client's timeout.

## [1.7.0] - 2026-07-12

### Added

- **`reflect` — the third verb, as one callable operation (THE-222).** New MCP
  tool (**134 total**): recall over the same measured front door, then a
  gateway synthesis pass — a grounded answer with source provenance in one
  query-scoped call. `mode: "challenge"` runs the adversarial red-team over the
  decision-bearing recall; `persist: true` writes the derived note under the
  memory folder's `reflections/` with `source_model` + exact chunk provenance
  (gated on `write:notes`). Degrades gracefully without the gateway. The
  sleep-time half runs via the new `obsidian-tc reflect` CLI command: the
  evaluator pass stamps pending work episodes (born-ineligible rows are never
  raised; unstable ok/error clusters are held; the optional judge can only
  lower, with a parse-failure kill switch), and gateway-gated preference
  extraction updates the new **versioned preference profile** — typed deltas
  only (add/strengthen/weaken/retract with weight counters), never monolithic
  regeneration.
- **Anticipatory context prefetch (THE-136).** New CLI command
  `obsidian-tc prefetch [path] [--vault id] [--ttl-hours N]` composes
  vault_context's session-bootstrap bundle per vault and writes a prewarm cache
  (`prewarm-<vault>.json` in the cache dir, atomic tmp+rename). Bootstrap mode
  now reads that cache — with the TTL **enforced at read time** and a
  signal-content hash so an edited `_next-session.md` invalidates immediately
  (the FlowState-QMD staleness bug, fixed and pinned by test) — and writes
  through on a live compose. A prefetch that packs nothing writes an empty
  marker, never a wrong bundle.
- **Proactive lesson surfacing in vault_context (THE-231).** The composite call
  now returns a `lessons` leg — decision/lesson/postmortem chunks relevant to
  the query (engine-ranked hits first, BM25 backfill over lesson-class paths) —
  and gains a session-bootstrap mode: omit `query` and the queued thread is
  read from the memory folder's `_next-session.md` signal note, so every
  session opens with its applicable past lessons (push, not pull). Composition
  only: packing and ranking are untouched.

## [1.6.0] - 2026-07-11

### Changed

- **`embeddings.chunkContext` now defaults ON (THE-408).** Contextual chunk enrichment measured
  +0.223 nDCG@10 (p=0.0001) and survived a 126-query re-test; with the divergence rebuild now
  enrichment-aware there is no remaining representation-skew hazard. **Upgrade note:** an existing
  index built with the flag off re-embeds in full on the first reconcile after upgrading (chunk
  content hashes cover the enriched text). Set `embeddings.chunkContext: false` to keep the old
  raw-text representation.

### Added

- **Conditional temporal retrieval stream, flag-gated (THE-221 Phase 1).** `temporal` on
  vault_graph_search's engine options: when the query carries an explicit temporal constraint
  (precision-first parser — prepositioned months/years, ISO dates, early/mid/late month, relative
  forms; bare title-style "May 2026" tokens never route), chunks of notes whose filename date
  falls in the parsed range join the fusion ranked by proximity to the range midpoint. Empty on
  non-temporal queries — exactly the static configuration. Eval gains `--temporal`. Off by
  default pending its A/B. (The ticket's date-augmentation item is already satisfied by THE-406
  enrichment: dated titles are in the embedded text.)
- **The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan).**
  A physically separate membrane store (`experiential.db`) now captures work-memory:
  - **Serve-path retrieval logging + the outcome axis (THE-230).** The search tools
    (`search_semantic`, `search_vault` semantic mode, `vault_graph_search`,
    `knowledge_challenge`) append retrieval events (chunk, rank, score, query text, surface,
    session) to `chunk_retrievals` — tool-layer only, so eval runs never pollute the log.
    Config `experiential.logRetrievals` (default on). A new `outcome` column (−1|0|+1,
    migration `20260711_001`) folds multiplicatively with relevance feedback in the ACT-R
    activation recompute (bounded weight ∈ [0.25, 4]).
  - **agent_episodes capture bus (THE-228).** A new registry `onEpisode` hook fires once per
    dispatch outcome (every dispatch, session or not); the bus appends append-only episodes
    (migration `20260711_002`) with self-carried caller/session attribution, a per-caller
    `prev_id` chain, and write-on controls stamped at birth (`eligibility='pending'`, blocked
    tombstone, bi-temporal validity). Action-axis capture (`experiential.captureEpisodes`)
    defaults on; the content axis (`experiential.captureContent`, secret-scanned + size-capped
    raw args) defaults off.
  - **Pre-ingest poisoning defense (THE-238).** A deterministic scanner (instruction-override
    markers incl. es/fr/de calques, persistence/preference-drift and delayed-trigger
    directives, hidden-text vectors — zero-width, bidi override, directive HTML comments,
    opaque blobs — and exfil shapes) runs in memory on every capture regardless of content
    persistence; high-risk content is born `ineligible` and never auto-raised. Per-channel
    trust contracts (dispatch 0.6 > ambient 0.3 > import 0.2; risk only lowers trust). The
    red-team acceptance harness ships in the test suite.
  - **M8 experiential tool domain (THE-229) — 4 new tools, 132 total.** `work_search`
    (memory retrieval with the reader contract enforced: eligible-only by default, tombstoned
    and expired rows never surface, per-agent caller partition, trust floor 0.3),
    `work_episodes` (inspection), `work_forget` (the tombstone as a first-party verb),
    `record_retrieval_feedback` (manual feedback/outcome stamping).
  - **Activation is measurable end-to-end (THE-187, THE-193).** The eval harness gains
    `--activation` and the serve path gains `experiential.activationRerank` (dark by default)
    — one bubble-pass mechanism on both paths, no eval/serve skew. Stale floor decided: clamp
    at 0.5 (time alone never demotes below never-retrieved; explicit negative feedback/outcome
    may). First live A/B at n=136: exact equivalence — ships dark per the ship rule.
  - **Citation inference (THE-170).** `obsidian-tc citation-infer <config> --transcript <file>
    (--session <id> | --since <ms> [--until <ms>])` — the two-stage gate (ROUGE-L +
    stored-embedding cosine, then the gateway judge role with a 5% parse-failure kill switch)
    stamps `cited_in_response`/`citation_score`. `session_id` is threaded into every
    retrieval-log call.
  - **Contribution report (THE-249).** `obsidian-tc contribution-report <config> [--since]
    [--until] [--json]` — per-note output-contribution credits over the citation signal, with
    top-contributor and dead-retrieved review lists.

### Fixed

- **chunk_fts divergence-rebuild is enrichment-aware (THE-408).** A wholesale rebuild (first
  FTS-capable open of an older index, or writes made without FTS5) previously reconstructed raw
  chunk text even under an enriched index, silently de-enriching the BM25 stream while the dense
  side stayed enriched. The indexer now threads `embeddings.chunkContext` into every
  `ensureChunkFts` call site and the rebuild reconstructs the enriched text from
  path + headings + content.
- **Tool-count headline drift healed.** All eight documentation surfaces and the coherence
  script's patterns now agree at 132 tools across 29 domains.

## [1.5.0] - 2026-07-11

### Changed

- **graph_rrf fusion constant k: 60 → 10 (THE-397), config-exposed as `retrieval.rrfK`.** With
  ~30-item stream pools, k=60 mathematically lets a document ranked ~30 in two streams outrank a
  rank-1 single-stream dense hit, burying confident results under overlapping noise. Measured on
  the n=32 golden set: k=10 is better-or-equal on all four gate metrics (nDCG@10 .444 vs .426,
  recall@10 .586 vs .569, MRR +.024, bridge recall equal), replicated on a second index.

### Added

- **Asymmetric embedding prefixes, config-driven (THE-405).** `embeddings.queryPrefix` /
  `embeddings.documentPrefix` (both default empty) apply at the provider factory: query-side
  embeds (`input: "query"`) get the query prefix, indexing gets the document prefix — the seam
  models like Qwen3-Embedding require (`Instruct: ...\nQuery: ` on queries, documents plain).
  Empty prefixes are the identity; nomic-style prefixes measured harmful on this vault, so
  nothing changes unless a config opts in.

- **Selective query-decomposition spike in the eval harness (THE-404).** `eval/run.ts --decompose`
  decomposes z-HARD queries only (z1 below `DECOMPOSE_Z`, default 2.54) into 2–3 atomic
  sub-queries via a small local instruct LLM (Ollama, `DECOMPOSE_MODEL`), runs the full graph
  search per sub-query, and RRF-merges the ranked lists — the routed (never blanket) form the
  2025–26 evidence supports for private corpora. Eval-only; no engine change.

- **Z-margin confidence signal (THE-400).** `seedZMargin` — the top-1 z-score over the dense
  seed-cosine pool — is the model-agnostic replacement for absolute cosine thresholds (which do
  not transfer across embedding models; the 0.55 rerank gate fired 0/32 on nomic). Opt-in uses:
  `router.zThreshold` (skip expansion on a confident dense lock) and `gatedRerank.hardZ` (rerank
  only z-hard queries). The eval logs per-query `z1` + a calibration quantile line and gains
  `--z-router <t>` / `GATED_HARD_Z`. Existing sim/margin + hardTop1 rules unchanged by default.

- **Convex-combination fusion mode, flag-gated (THE-398).** `fusionMode: "convex"` fuses per-query
  min-max-normalized RAW stream scores (dense cosine, expansion cos·decay, negated BM25, sparse
  dot) as `α·semantic + (1−α)·lexical` (α default 0.7) instead of rank-based RRF — preserving the
  dense model's confidence margins that RRF discards (Bruch et al., arXiv:2210.11934). Shares the
  graph_rrf diversification + gated-rerank pipeline; eval gains `--fusion convex` + `CONVEX_ALPHA`.
  Off by default pending its A/B vs RRF k=10.

- **Smooth expansion scoring, flag-gated (THE-401).** `smoothExpansion` replaces the graph
  stream's two hard discontinuities — the lexicographic hop-then-cosine order (any 1-hop beats
  every 2-hop) and the `hubDegreeCap` Heaviside drop (measured to cost bridge recall 0.7→0.4 at
  cap 40) — with one continuous score `cos · λ^(hop−1) · 1/(1+(deg/μ)^γ)` (defaults λ=0.8, μ=75,
  γ=6, tuned to this vault's bridge-vs-hub degree split). Composes with `graphStream` caps and
  Ebbinghaus decay; the similarity gate still uses raw cosine. Off by default pending its A/B.

- **Contextual chunk enrichment, flag-gated (THE-406).** `embeddings.chunkContext` embeds and
  BM25-indexes each chunk as `"{note title} — {heading breadcrumb}\n\n{content}"` instead of the
  bare section text. The chunker consumes heading lines into metadata, so a note whose evidence
  lives in its name or headings was invisible to BOTH retrieval streams (the golden-set failure
  taxonomy attributes ~49% of misses to promotion/representation, not recall). Display content is
  unchanged; the chunk content hash covers the enriched text, so flipping the flag re-embeds on
  the next reconcile. Default off pending its A/B gate.

- **Configurable `bge-m3` embeddings provider (THE-395).** `embeddings.provider: "bge-m3"` speaks
  an OpenAI-compatible vLLM base (`baseUrl`, default `http://127.0.0.1:8000/v1`): dense via
  `/embeddings`, plus the learned-sparse and ColBERT heads via the THE-388 encoder at index time
  (`chunk_sparse` / `chunk_colbert`), so a bge-m3 index carries all three representations. The
  retrieval eval gains `--sparse` to fuse the learned-sparse RRF stream query-side.

### Fixed

- **Embed batches no longer overrun a small provider context, and a rejected request no longer
  aborts the whole reindex (THE-390).** Ollama loads models at `n_ctx` 4096 by default and
  400-rejects any `/api/embed` request whose summed tokens exceed it; the chars/4 estimate
  undercounts real tokenization (~2-2.5x on link-dense markdown), so the previous 8192-estimated
  budget could overrun a 4096 context and halt the boot reconcile partway (`reconcile: degraded`,
  `HTTP 400`). `embeddings.maxBatchTokens` now defaults to 2048; a rejected (HTTP 400/413) batch
  is bisected and retried; a chunk rejected even as a single-text request quarantines its note —
  skipped this pass, surfaced via `notes_embed_failed` + degraded reconcile health, retried next
  reconcile — instead of aborting the reindex. Outage-class errors (timeout / 5xx) still abort.

## [1.4.0] - 2026-07-10

### Added

- **`session_bootstrap` tool (THE-101).** Server-side session bootstrap so any MCP client (Cursor,
  ChatGPT, Cline, Continue), not just skill-enabled Claude, can triage its opening message
  (lightweight | standard | deep) and preload the matching vault context notes through the headless
  FilesystemBackend. The routing table (deep-mode paths + a domain signal-to-path map) is supplied
  via the new `bootstrap` config block, never baked in; with none configured the tool degrades to
  lightweight. Read-only. Tool surface 122 to 123.

### Fixed

- **Local-Ollama indexing robustness (THE-386, GH #171 / #172).** The default local-Ollama embedding
  path could not index a real vault out of the box. Three fixes: (1) embed requests were aborted at a
  hardcoded 30s with no knob, so a slow local model presented as a hang — added `embeddings.timeoutMs`
  (default 120s), threaded through the provider adapters; (2) boot-reconcile failures were recorded
  only in in-memory index health, never stderr, presenting as a permanent silent stall — a degraded
  reconcile now emits a stderr warning per vault with a remediation hint; (3) a fixed 512-input embed
  batch could pack ~87k tokens into one request and crash a stock local runner (`/tokenize: EOF`) —
  batches are now capped by BOTH input count and estimated tokens (`embeddings.maxBatchTokens`,
  default 8192), and a single over-budget text still goes alone. `embeddings.batchSize` /
  `concurrency` / `maxBatchTokens` are all configurable.

## [1.3.6] - 2026-07-05

### Fixed

- **CLI no longer crashes at boot under GUI launchers (EPERM on `mkdir .obsidian-tc`).** The
  `cacheDir` default `.obsidian-tc` was relative, so the server tried to create it in the process
  CWD. GUI MCP launchers spawn with a non-writable CWD (Claude Desktop uses `C:\WINDOWS\system32`),
  so boot failed with `EPERM: mkdir 'C:\WINDOWS\system32\.obsidian-tc'`. A relative `cacheDir` is
  now anchored to the user's home (`~/.obsidian-tc`) — absolute and CWD-independent; explicit
  absolute `cacheDir` values are unchanged. `serve <vault>` now works from any launcher.

## [1.3.5] - 2026-07-05

### Security

- **Intermediate-directory symlink-swap TOCTOU closed (THE-272).** `read_note` / `write_note` now
  route through a native symlink-safe open — a per-component `openat(O_NOFOLLOW)` walk (Rust /
  `rustix`) that follows no symlink in any path component and operates on the resulting fd — so an
  attacker cannot redirect a read/write by swapping an ancestor directory for a symlink between the
  ACL check and the open. Active on all published platform prebuilds; the pure-JS fallback keeps the
  prior hard-link + final-component guards, and Windows uses the JS path (symlink creation is
  admin-gated there). Closes the last residual behind GHSA-c5xx.
- **`copy_note` overwrite is now gated + recoverable.** Overwriting an existing destination with
  `copy_note` (`overwrite: true`) previously clobbered it irreversibly with no confirmation floor; it
  now requires HITL confirmation and soft-deletes the destination into `.trash` first, matching
  `move_note`.

### Fixed

- **`obsidian-tc` CLI now runs from the npm bin on Windows.** The published `dist/cli.js` shipped
  without a `#!/usr/bin/env node` shebang, so npm's generated launcher shim handed the file to the
  Windows file association (Script Host) instead of node, and `obsidian-tc serve ...` silently
  no-opped (exit 0, no output) while `node .../dist/cli.js serve ...` worked. The build now prepends
  the shebang to the bin (POSIX exec bit set, sourcemap kept accurate) and install-smoke asserts it.
- **Multi-vault GraphRAG edge isolation (THE-310).** `vault_edges` now carries `vault_id`
  (migration 20260703_001): `reconcileVaultEdges` scopes its full-state SELECT/DELETE to the vault
  and `vault_graph_search`'s walk filters by `vault_id`, so reindexing one vault no longer deletes
  another vault's wikilink edges and expansion never crosses vaults. Single-vault deployments are
  unaffected; the edge cache rebuilds on the next `index_vault`.
- **Cohere query embeddings use the query encoding (THE-308).** The Cohere provider hardcoded
  `input_type: "search_document"` for every embedding, so user queries were encoded as documents and
  landed in a different subspace than the indexed vectors, degrading recall. `embed` now takes an
  `input: "query" | "document"` option; the two query sites pass `"query"` (→ `search_query`) while
  indexing keeps the document default. Cohere-only; other providers are unaffected.
- **`knowledge_challenge` gives the judge tags + open contradictions (THE-309).** Evidence is now
  enriched with note-level frontmatter tags — so a decision-tagged note outside the decision folders
  is recognized — and open contradictions touching the evidence paths are passed into the judge for
  cross-note conflict context; previously it sent path-only evidence and an empty contradiction list.

### Docs

- **Retrieval claims corrected to match the code (external claim audit).** Reworded the "hybrid BM25 +
  vector + RRF fusion" phrasing in README/ARCHITECTURE — there is no general lexical+vector RRF
  retriever; RRF fuses only GraphRAG's seed/expansion streams (THE-196) — and reconciled the docs-site
  roadmap/v2-preview, which still framed obsidian-tc as "an access MCP; pair with an external
  retrieval/RAG service", to the 2026-06-25 converged-engine decision. Documented the single-vault
  GraphRAG edge caveat (THE-233).

## [1.3.4] - 2026-07-03

### Changed

- **Docs reflect the shipped version + registered surface.** Swept the version prose (README status
  badge/line, docs-site current-release line + ghcr example tags) from 1.3.2 to 1.3.3 and the example
  tool-count output from 103 to 105. `release.mjs` now bumps the version prose on every cut and
  `check-version-coherence.mjs` fails if it drifts from the package version (recurrence fix). The
  GitHub wiki was refreshed to match.
- **npm package README refreshed.** `packages/server/README.md` — the README npm renders for the
  `obsidian-tc` package — carried a stale `Shipped — v1.0.2` status while shipping 1.3.x; it now
  tracks the shipped version and is covered by the version-prose gate + release auto-bump.

## [1.3.3] - 2026-07-03

### Security

- **Folder-ACL case-fold hardening (THE-272).** The `.obsidian` / `.git` / `.trash` default-deny now
  matches case-insensitively, so a case-variant control-directory path (e.g. `.Obsidian/…`) can no
  longer evade the deny on a case-insensitive filesystem. Path whitelists likewise match
  case-insensitively on case-insensitive filesystems (Windows/macOS) and stay case-sensitive on
  Linux. The intermediate-directory symlink-swap TOCTOU remains a documented residual (needs a
  native per-component `openat`; still tracked on THE-272).

### Changed

- **`elicitTtlSeconds` now governs HITL token TTL (THE-302).** The accepted config key is wired: the
  server sets the default elicit-token lifetime from config at startup instead of the hardcoded 300s;
  an explicit per-call `ttlSeconds` still overrides it.
- **`release.mjs` formats after the bump (THE-301).** The release script runs `bun run format` after
  writing the version files, so a release commit never carries biome drift.
- **Build hygiene (THE-278).** The root `package.json` pins `packageManager: bun@1.3.14` to match the
  CI toolchain.
- **Tool count corrected to 105 and pinned (THE-306).** The registered surface is 105, not 106 (a
  manual miscount in 1.3.2). A new `tool-count` test asserts the assembled registry length and
  `check-version-coherence.mjs` now fails if the documented headline drifts from it; the count is
  corrected across the README, ARCHITECTURE, and the docs site.
- **Companion plugin ships the complete 3-file set (THE-206).** The build now emits `styles.css`
  beside `main.js`/`manifest.json`, the release zip includes it, and the three files are attached to
  the GitHub Release as individual assets so BRAT can sideload the plugin (community-store
  submission readiness).

### Documentation

- **Accepted-residuals section + release runbook.** SECURITY.md gains a "Known limitations and
  accepted residuals" section documenting the `move_attachment` cross-ACL link rewrite (N-3,
  THE-303), the exp-only-token max-age contract (M-3, THE-304), and the intermediate-directory
  symlink-swap TOCTOU residual (THE-272). New `docs/RELEASING.md` captures the single-command +
  human-tag release flow and the community-store submission path (THE-256).

## [1.3.2] - 2026-07-03

### Security

- **Hard-link folder-ACL bypass closed (C-1b).** `enforcePathAcl` and the fd-based `readNote` /
  `readFileChecked` reject a regular file with `st_nlink > 1` in an ACL'd vault, so a hard link can
  no longer alias a file outside the caller's folder ACL (or past the `.obsidian` default-deny) into
  an allowed path — realpath canonicalization cannot dereference a hard link. Reads open an fd and
  fstat it, so the inode check and the read run on the same object.
- **Atomic-write temp-file symlink TOCTOU closed (H-4).** `writeNoteAtomic` opens its temp file
  `O_EXCL | O_NOFOLLOW` with a randomized name, so a symlink planted at a predictable temp path can
  no longer redirect an in-ACL note write into an arbitrary file.
- **`get_attachment` no longer reads arbitrary files (N-1).** It enforces the attachment extension
  allowlist (matching `list_attachments`), so `read:attachments` grants binary attachment reads, not
  read-any-file; notes are read via `read_note` under `read:notes`.
- **Elicit (HITL) tokens are caller-bound (H-3).** Redemption checks the issuing caller, so on a
  multi-caller HTTP deployment one caller cannot spend another's confirmation for the same vault + args.
- **Attachment reference lists are ACL-filtered (N-2).** `get_attachment(include_references)` and
  `delete_attachment` reveal only referencing notes the caller may read, closing a note-path
  enumeration channel.
- **`config show` redacts credential-header values (H-5).** `observability.otel.headers.Authorization`
  and `morgiana.httpHeaders.Cookie` (and similar) are masked by header name, not just key suffix.
- **`list_attachments` honors `strictReadDefault` (N-4).** Its read filter uses the shared
  `readableRel` predicate, which also applies the `.obsidian`/`.git`/`.trash` default-deny.
- **`/metrics` enforces the token max-age (M-3).** The Prometheus scrape verify threads
  `auth.tokenTtlSeconds`, so an over-age `iat`-bearing token can no longer scrape metrics
  indefinitely. The exp-only-token contract (max-age applies only to `iat`-bearing tokens) is
  unchanged and tracked separately.

### Changed

- **Companion plugin rejoins the repo version lockstep** (`scripts/release.mjs` +
  `scripts/check-version-coherence.mjs` now include it), and the tool count is corrected to 106
  across the docs, with the fd/inode path-safety + caller-bound elicit documented.

## [1.3.1] - 2026-07-03

### Fixed

- **Native platform sub-packages now publish with public access (packaging).** New scoped npm
  packages default to `restricted`, so the first publish of the new musl platform sub-packages
  hit `402 Payment Required`. The publish workflow now sets `publishConfig.access = "public"` on
  every generated platform package before `napi pre-publish`, and `packages/native` declares it
  too. (The `v1.3.0` tag's publish stopped at this step; `1.3.1` is the first fully published cut
  of this feature batch.)

## [1.3.0] - 2026-07-03

### Added

- **Tool-surface facade / progressive disclosure (THE-219 consolidation).** A new
  `transports`-independent `toolFacade.mode` (`triad` default, `domain` reserved, `flat` back-compat)
  reshapes what `tools/list` advertises WITHOUT removing any capability. In `triad` mode the server
  advertises three meta-tools instead of the full ~103: `find_capability` (BM25 search over the
  caller-visible catalog, reusing the in-process tokenizer/BM25, no new index), `describe_capability`
  (a single tool's schema + scopes + safety hints), and `call_capability` (routes the named target
  straight through `registry.dispatch`, so every scope/ACL/HITL/idempotency/throttle gate and the
  target's own Zod validation fire unchanged). Boundary-only: the ACL/Policy/HITL/idempotency/throttle
  pipeline and observability are untouched, and every tool remains callable by name. `flat` mode is the
  previous full-surface behavior. (Domain-verb facade + Claude-native deferred-tool discovery are follow-ups.)

- **Native `linux-x64-musl` + `linux-arm64-musl` prebuilds.** The publish matrix now builds eight triples (was six); Alpine/musl hosts load the compiled native addon instead of the pure-JS fallback. The hand-written loader detects musl vs glibc (`process.report.glibcVersionRuntime`, then `/usr/bin/ldd`) and requests the `-musl` triple. musl targets cross-compile via `napi build -x` (cargo-zigbuild + zig). The actual musl publish is validated on a release tag (the cross-build cannot run on non-linux/local dev).

### Changed

- **SQLite per-connection baseline + prepared-statement cache (THE-273).** Both runtime adapters now set `synchronous=NORMAL` (WAL-safe), `busy_timeout=5000` (wait instead of `SQLITE_BUSY` when the reindex, boot reconcile, and a live tool call contend for `cache.db`), a 32 MB page cache, `mmap_size`, and `temp_store=MEMORY`. The per-dispatch audit + idempotency statements are prepared once via a new `prepareCached` (bun:sqlite's `db.prepare` is uncached), removing a parse-per-call on the hottest path.
- **Distribution hardening (THE-276).** The packed `.mcpb` no longer ships local state / non-runtime files (`.claude/` including `settings.local.json` + `state/`, `.ruff_cache/`, `.gitleaks.toml`, `.gitattributes`, and the stray 26 KB `packages/native/false` left by `napi build --js false`). The server bundle is now built with `--minify --sourcemap=linked` (it was ~2.4 MB parsed on every stdio spawn), and the standalone `--compile` binaries add `--bytecode --minify --sourcemap` for faster cold start.
- **Batched embeddings on index / reconcile (THE-277).** `indexVault` now computes all of a batch's chunk plans first and embeds them together in provider-sized sub-batches under bounded concurrency, instead of one serial `embed()` round-trip per note. A cold/warm reconcile makes ~`ceil(chunks / 512)` requests with a few in flight rather than one per changed note; the write lock is still never held across a network call and the stored vectors are unchanged.
- **Parallelized the contradiction sweep (THE-277).** The post-index contradiction detector judged each (chunk, neighbor) pair with a serial `judge()` round-trip; it now windows the judge calls at 4 in flight (neighbor discovery and the DB inserts stay serial on the single connection), and a single pair's judge failure degrades to `no_conflict` instead of sinking the batch.
- **Domain-verb facade mode (shipped under THE-275 — see correction).** _Correction, 2026-07-26: THE-275 was **cancelled**, and this entry credited it with shipping. The feature below is real and shipped in 1.3.0; the attribution was misleading. THE-275's actual proposal — per-tool visibility `tags` plus a hand-curated ~20-tool preset — was never built (only 15 of 150 definitions carry `tags`). The domain-verb mode below **superseded** that proposal rather than implementing it. Rationale and the current default's standing: `docs/adr/0006-the-default-surface-is-the-triad.md`._ `toolFacade.mode: "domain"` now advertises ~a dozen domain meta-tools (`notes`, `metadata`, `links`, `search`, `vault`, `attachments`, `structured`, `workspace`, `automation`, `knowledge`, `admin`) instead of the full ~100-tool surface or the triad. Each takes a shallow `{ action, args }` and routes the named action through the same `registry.dispatch` pipeline (every ACL / HITL / idempotency / throttle gate and the target's own schema validation fire unchanged). Boundary-only; every tool stays callable by name, and an unmapped tool still ships under an `other` domain rather than being hidden.
- **Unicode-normalization-insensitive folder ACL (THE-272).** ACL glob matching and the default-deny check now normalize both the rule and the path to NFC before comparing, so a deny/whitelist rule authored in NFC still matches the same name stored on disk as NFD (notably on macOS) instead of silently failing to match. Residual path-hardening items remain open on THE-272 (hardlink / TOCTOU, which needs non-portable `openat`/`O_NOFOLLOW`, and case-folding, which cannot be applied blindly without breaking case-sensitive filesystems); the symlink canonicalization landed earlier in THE-269.
- **Tool / capability schemas emitted as JSON Schema 2020-12 (THE-278).** `tools/list` (flat), the facade meta-tools (triad + domain), and `describe_capability` now emit input schemas in the **2020-12** dialect (the MCP `2025-11-25` default) instead of draft-7. The server already negotiates protocol `2025-11-25` via `@modelcontextprotocol/sdk@1.29.0` (`LATEST_PROTOCOL_VERSION`); this aligns the advertised schema dialect with the negotiated version. draft-7 remains spec-valid, so this is a forward-alignment with no client-visible breakage.
- **MCP 2025-11-25 tool-surface alignment (THE-278).** Three spec-aligned additions, all opt-in and non-breaking: (1) a dispatch failure now returns as a **Tool Execution Error** with a human-readable sentence plus the full error (including the Zod issues) as `structuredContent`, so a model can self-correct (SEP-1303), instead of an opaque JSON blob; (2) `ToolDefinition` gains an optional **`outputSchema`** advertised in `tools/list` + `describe_capability` (conformant clients then validate the `structuredContent` the server already emits); (3) optional **`icons`** metadata on tools (and prompts). Tools that declare neither `outputSchema` nor `icons` serialize byte-identically to before.
- **OAuth 2.0 Protected Resource Metadata + `WWW-Authenticate` challenge (THE-278).** When the operator sets `auth.resource` plus at least one `auth.authorizationServers` entry, the HTTP transport serves an RFC 9728 Protected Resource Metadata document at `/.well-known/oauth-protected-resource[/mcp]` and returns `WWW-Authenticate: Bearer resource_metadata=...` on a 401, so a spec-compliant MCP client can discover the authorization server (MCP 2025-11-25 resource-server role). Opt-in and non-secret; the HS256 token format is unchanged and the default config (no `resource`) serves nothing. The authorization-server half (token issuance, Dynamic Client Registration, OIDC discovery) remains out of scope until a real external AS exists.
- **Docs site reconciled with shipped reality (THE-278).** The documentation site was audited against the code and corrected: JSON-only config (not YAML) with real defaults (`http.port` 8765, `perMinute` throttle tiers + a `delete` tier, retention 90/90/30, `ollama` embeddings), Node 24+, the 8-triple native matrix, the `oven/bun:1-slim` Docker base, the `.mcpb` + minified-bundle artifacts, the `toolFacade` (triad default / domain / flat) surface with derived annotations + optional `outputSchema`/`icons` + JSON Schema 2020-12 (MCP 2025-11-25), the `delete` scope class/tier and corrected error codes (`forbidden` / `throttled` / `overflow`), and the optional RFC 9728 Protected Resource Metadata. Version references updated to v1.2.1.
- **Repo docs reconciled with reality (THE-278).** `ARCHITECTURE.md` now reflects the shipped MCP surface (`tools/list` emits `title` + derived annotations + optional `outputSchema`/`icons` as JSON Schema 2020-12; `resources` + `prompts` capabilities are advertised; auth is `none`|`jwt` with optional RFC 9728 Protected Resource Metadata, not an `oauth`/DCR mode), `CONTRIBUTING.md` corrects the native matrix to eight triples + the CI job list, and the README notes the default tool-surface facade.
- **Node falls back to built-in `node:sqlite`, making the one-click `.mcpb` self-contained (THE-276).** Under Node the server still prefers `better-sqlite3` (native, fastest) but falls back to the built-in `node:sqlite` when `better-sqlite3` cannot be resolved — notably inside the packed `.mcpb`, which ships no `node_modules`. The bundle is now installable and usable under Node 24+ on macOS, Windows, and Linux with no native dependency (`ci-install-smoke` proves the no-`better-sqlite3` boot on all three OSes); vector search uses the existing brute-force fallback when the sqlite-vec extension can't load. npm installs (which include `better-sqlite3`) are unchanged.
- **`linux-arm64` standalone binary + `.mcpb` attached to releases (THE-276).** The release now builds a `bun-linux-arm64` standalone binary, so the no-runtime binary covers macOS x64/arm64, Windows x64, and Linux x64/arm64, and it attaches the one-click `obsidian-tc.mcpb` bundle to the GitHub Release (self-contained under Node 24+ via the `node:sqlite` fallback). Windows-arm64, which is not a `bun --compile` target, is covered by the npm install. The install docs gain a per-platform method matrix.
- **DCO governance + dual-license note (THE-263).** Sign-off is now **required**: a new lightweight `dco` GitHub Action verifies every non-merge commit in a PR carries a `Signed-off-by` trailer (merge commits and existing history exempt). CONTRIBUTING and the README now state the project is AGPL-3.0-only with a commercial-exception license potentially available on request (no terms committed). Docs / CI only — no runtime or tool-surface change.
- **Multi-stage Docker image (THE-276).** The `Dockerfile` is now two stages on glibc `oven/bun:1-slim`: a builder that installs deps and builds shared + server, and a runtime stage that copies **only** `packages/server/dist` (no source, no `node_modules`). It runs under Bun (`bun:sqlite`), degrading the native module + sqlite-vec to pure-JS exactly as the previous image, for a smaller runtime layer. The `ci-docker` PR gate builds it and runs the `version` smoke.
- **Idempotency observability wired (THE-197).** The three idempotency Prometheus series are now live instead of registered-zero: `obsidian_tc_idempotency_hits_total` increments on a cache replay, `obsidian_tc_idempotency_cache_skipped_total` when a keyed result is dropped over the response-byte cap, and the `obsidian_tc_idempotency_cache_bytes` gauge reports the live per-vault cache size (`SUM(result_size)` over unexpired completed rows). Metrics only; no tool-surface or behavior change.
- **Terse search projection (THE-251).** The read/search hit tools (`search_text`, `search_regex`, `search_semantic`, `search_jsonlogic`, `search_vault`, `find_notes_by_property`) accept an opt-in `verbosity: "full" | "terse"` (default `full`). In `terse` mode each hit collapses to `path` plus `score`/`snippet` when present, dropping heavy per-hit fields (line/col, chunk id, chunk content, matched value) to cut agent prompt cost. Full mode is unchanged.
- **In-session tool-invocation tracing (THE-209).** When a workspace session is active, each tool dispatch now appends a `tool_invocation` record (`{ts, tool, caller, duration_ms, args_hash, result_size, status}`) to that session's JSONL trace, so `get_session_traces` reflects in-session activity without the external ambient worker. Wired via an opt-in `sessionTracer` on the dispatch registry plus a process-local active-session tracker (`start_session`/`end_session` maintain it; the stdio transport stamps `ctx.sessionId`). Best-effort — tracing never breaks a dispatch. No tool-surface change.
- **Templater expansion for periodic notes (THE-207).** `create_periodic_note` and `find_or_create_periodic_note` accept an opt-in `expand_template` (default `false`). When set, the configured or overridden template is expanded through the Templater bridge (which writes the note itself), gated on the `write:templater` scope; it degrades cleanly to a verbatim copy when the companion or Templater plugin is unavailable. Default behavior (verbatim copy) is unchanged.
- **Zero-copy `Float32Array` cosine on the native brute-force path (THE-266).** The native `cosine_similarity` now accepts the document vector as a zero-copy `Float32Array` (the query stays f64), widening each element f32->f64 in-loop so the result is bit-identical to the pure-JS fallback (guarded by a strict `===` parity test). `blobToFloats` returns the `Float32Array` view directly instead of copying into a `number[]`. Cold-path optimization (only the sqlite-vec-unavailable brute-force scan); the rebuilt prebuilds ship with the next native release cut.
- **`.mcpb` bundle no longer leaks non-runtime tracked files (THE-276).** The MCPB denylist now excludes tracked root config/tooling that is not part of the runtime bundle — `.gitleaks.toml` (the named leak), `biome.json`, `bun.lock`, `tsconfig.base.json`, `server.json`, `Dockerfile`, `.mcpbignore` itself — plus local-only `.claude/` and `.ruff_cache/`. The packed bundle now ships only `packages/server/dist`, `manifest.json`, `package.json`, `README.md`, and `LICENSE`.
- **Obsidian-fit fixes (THE-284).** `read_canvas`/`query_canvas` now surface spec-valid edge `fromEnd`/`toEnd` and group-node `background`/`backgroundStyle` (previously dropped from the read projection; the on-disk round-trip was already lossless). `query_base` now refuses a base written with the real Obsidian Bases expression DSL (a bare-string filter, an `and`/`or`/`not` of string statements, a top-level `filters`, or a string formula) with a typed `unsupported_base_filter` instead of silently matching all rows; obsidian-tc's own JSONLogic base model is unchanged (superseded in-cycle: the THE-281 subset evaluator now runs pure string-DSL filters/formulas; mixed trees still refuse). ARCHITECTURE.md's dependency chain now reflects that M1 CRUD, M2 search, and M3 format reads are filesystem-native (Obsidian / Local REST API / companion are Tier-3 only).
- **Uniform symlink-canonical ACL enforcement (THE-286).** `enforcePathAcl`'s vault-root argument is now mandatory, so every path-based tool gates on the realpath-resolved vault-relative path (THE-269) instead of silently falling back to a lexical check. This closes the residual symlink-scope bypass on the callsites that previously omitted the root: the Templater / Excalidraw / OCR / Dataview bridges, memory-entity materialization, and the search / index / canvas / attachment / tasks / bundle folder-scope checks. Behavior is unchanged for non-symlinked paths.
- **Semantic search no longer crowds out ACL-visible hits (THE-287).** The vec0 KNN path over-fetched a fixed `k*5+10` global candidates then filtered by vault + read-ACL in JS, so a query whose top candidates were all in denied folders (or, under a shared cache.db, another vault) could return zero hits despite relevant visible matches — a functional DoS and a weak existence side-channel. The vault filter now runs in SQL, the over-fetch is widened, and when the top candidates cannot fill `k` visible hits the query falls back to the exhaustive (already ACL-correct) brute-force scan. Same results in the common case; correct results under crowding.
- **Config keys `transports.stdio` + `throttle.enabled` are now honored (THE-288).** Both were accepted by the schema but silently ignored: the stdio transport always connected and the dispatch rate-limiter always enforced regardless of the flags. `transports.stdio: false` now skips the stdio transport (the server serves HTTP-only, or exits with a clear message when neither transport is enabled), and `throttle.enabled: false` runs the dispatch gate with no limiter (the `RateLimiter` object still backs `get_metrics`, just unenforced). A non-typed handler exception (a server bug, previously swallowed into an opaque `{code:"internal"}` with the stack discarded) now also reaches an operator-side `onInternalError` sink that writes the real error + stack to stderr for diagnosis — the client response stays the redacted `internal`, and stdout (the MCP channel) is untouched.
- **`server_health` surfaces search-index degradation (THE-288).** Boot-reconcile failures and index-on-write failures were swallowed (`.catch(() => {})`), so the server reported healthy while its search index silently drifted. `server_health` now includes an `index` block: `reconcile` (`pending` / `ok` / `degraded`), `reconcile_at`, and a `write_failures` count (all non-identifying, always present); authenticated callers additionally get per-vault reconcile errors + the last write-error message (path-bearing `detail` is withheld from the unauthenticated liveness probe).
- **Documented the companion trust boundary (THE-289).** SECURITY.md and the companion plugin README now state explicitly that possession of the Local REST API bearer key is equivalent to full vault admin: the companion extends LRA's HTTP server and LRA's own endpoints already grant full read/write/delete, so the companion routes add no new authority and deliberately do not re-implement the server's ACL/HITL/command-allowlist gates (which protect the MCP surface, not direct LRA calls). Docs only.
- **Memoized per-request schema + capability-search work (THE-294, partial).** `tools/list`, `describe_capability`, and the triad meta-tools recomputed `z.toJSONSchema` over static schemas on every request, and `find_capability` re-tokenized the whole tool catalog per query. Both are now memoized by schema / tool-definition identity (the triad meta-tool schemas were hoisted to module constants so the cache hits), so each distinct schema is converted at most once and each tool's description is tokenized at most once. Pure internal caching — the advertised surface is byte-identical. (The remaining THE-294 items — caching the assembled HTTP server across requests, and dropping the dispatch/transport double-serialization — are deferred; both touch a per-request-context or shared-result contract and warrant their own change.)
- **Compare-and-swap for JSON-config edits (THE-292).** `add_bookmark`, `remove_bookmark`, `open_workspace`, and `save_workspace` now accept an optional `prev_hash` (like note writes): the edit is rejected with `concurrent_modification` when `.obsidian/bookmarks.json` / `workspaces.json` changed since that hash, closing a lost-update window versus a concurrent agent or the Obsidian GUI. Omitting `prev_hash` preserves the previous last-write-wins behavior. (THE-292's indexer-transaction item was already satisfied — `indexNote` / `indexVault` wrap their applies in BEGIN/COMMIT/ROLLBACK; the periodic cache.db maintenance sweep remains a follow-up.)
- **Compute-abuse budgets (THE-293).** (1) `search_regex` / `search_vault(mode:regex)` now enforce a TRUE regex-execution timeout: the scan runs in a lazily-spawned worker thread and only worker time counts against the budget (`governor.regexTimeoutMs`, default 2000 ms), so a catastrophic-backtracking pattern that slips the nested-quantifier heuristic is terminated with a new non-retryable `compute_budget_exceeded` error instead of hanging the event loop. A runtime that cannot run the eval worker (readiness handshake) falls back to the prior inline scan. (2) JSONLogic evaluation carries a 10k op budget counted on EVERY node — literals and wide flat argument lists included — so `search_jsonlogic` and `query_base` view filters reject pathological width with `jsonlogic_error` instead of burning CPU (the depth cap only bounded nesting). (3) The idempotency in-flight reclaim window is now configurable (`idempotencyReclaimSeconds`, default 60): a legitimately slow keyed bulk op can be given a longer window so a concurrent duplicate cannot false-reclaim its in-flight row and double-execute.
- **Dev-dependency audit freshen (THE-299).** `bun audit` reported 4 advisories (1 high) against stale lockfile resolutions — `vite@5.4.21` (fs.deny bypass on Windows, optimized-deps `.map` path traversal, launch-editor NTLMv2 hash disclosure) and its transitive `esbuild@0.21.5` (dev-server cross-origin read). vitest's declared range already admits vite 7; a root `overrides` entry now pins `vite` to `^7.0.0` so the lockfile re-resolves onto the patched line (bringing esbuild ≥0.25 with it). `bun audit` is clean. Dev/build-time only — no runtime dependency changed.
- **Index-on-write now covers every M1 note mutation (THE-291, part 1).** `add_tag`, `remove_tag`, `update_frontmatter`, `rewrite_link`, `prune_hub_links`, `move_note`, and `copy_note` wrote notes to disk WITHOUT firing the index-on-write seam (only `write_note`/`append_note`/`patch_note`/`delete_note` did), so the semantic-search index silently went stale on those writes until the next boot reconcile — a read-your-writes gap. All seven now reindex the written content (moves also deindex the source path and reindex every backlink-rewritten note). The m3 periodic / m4 tasks / m5 capture / m6 bulk writers get the same treatment in part 2 (their deps interfaces need threading).
- **Dropped one payload serialization per tool call (THE-294).** The dispatch pipeline stringified every successful result for the byte governor and the transport formatter stringified the same object again. The governor's string is now memoized by result-object identity (take-and-delete WeakMap) and consumed by the formatter — removing the formatter's pass (the JSON-RPC envelope still serializes `structuredContent`, so this is one of three passes, not a halving). Idempotency replays reuse the cached blob string the same way. Wire bytes are identical. The remaining THE-294 item — caching the assembled HTTP `Server` across requests — is closed as wontfix: the MCP SDK enforces one transport per `Protocol` instance (`connect` throws on a second transport), the stateless Streamable-HTTP mode needs concurrent per-request transports, each `Server` captures the per-request auth context, and the formerly-expensive per-request work (schema conversion) is already memoized module-level.
- **Periodic cache.db maintenance sweep (THE-292).** Expiry was lazy-only — expired `idempotency_keys` / `elicit_tokens` rows were rejected on read but never purged, and the `event_log` retention config (`observability.retention.eventLogDays`, default 30) had no enforcement — so cache.db grew without bound. An hourly (configurable via the new fully-defaulted `maintenance` block: `enabled` default true, `intervalMinutes` default 60) unref'd sweep now DELETEs expired rows, trims `event_log` to retention, and runs `PRAGMA optimize`; each run emits a `tc.maintenance.sweep` MORGIANA event (new additive event type with a `rows_dropped` per-table breakdown) and a `sweep_run` event_log row. The sweep is deliberately expired-only for idempotency rows — crashed in-flight reclaim stays on the dispatch path (`idempotencyReclaimSeconds`, THE-293) where a fresh claim cannot be cross-attached to a stale completion. No automatic VACUUM. External MORGIANA consumers pinned to an older shared schema must tolerate the new event type before consuming a server that emits it.
- **Index-on-write coverage extended to the m3–m6 writers (THE-291, part 2).** `create_periodic_note` / `find_or_create_periodic_note` / `append_periodic_note`, `update_task`, the m5 capture commit, `bulk_create_notes`, `bulk_set_property`, and `bulk_move_notes` (moves deindex the source and index the destination) now fire the same best-effort index-on-write hooks as the M1 tools, completing the part-1 sweep. Residuals documented on the ticket: `bulk_move_notes` backlink rewrites and Templater-expanded periodic notes (written by the companion, not the server) still rely on the boot reconcile.
- **Notes metadata table + FTS5 substrate (THE-291, part 3A).** cache.db gains a versioned `notes` table (per-note title / tags / frontmatter / content-hash / stat metadata) and a runtime-provisioned `notes_fts` FTS5 virtual table (trigram tokenizer — candidate generation stays a superset of substring matching), populated on the index-on-write path and the boot reconcile in the same transactions as the chunk store. Design per the adversarial review: the FTS copy derives from the RAW note (secret-flagged chunk contents excised) so heading lines and hard-split boundaries cannot create silent false negatives; the notes/FTS pass flushes independently of the embed pass and reports `notes_ready` in `server_health` (a broken embedding backend no longer blocks metadata readiness); the stale-path sweep runs only on unscoped reconciles and diffs against the unfiltered walk; a sync detector reconverges `notes`/`notes_fts` after sessions written without FTS5. Deletes/moves clear metadata via a new one-transaction `deindexNote`. `server_health` reports `fts_enabled`; `index_vault` stats gain `fts_enabled`/`notes_upserted`/`notes_deleted`. The query layer (accelerated `search_text`, DB-backed `list_tags`/`list_properties`/`find_notes_by_*`) lands as part 3B on this substrate.
- **`search_text` is FTS5-accelerated (THE-291, part 3B).** When the notes/FTS pass is ready, `search_text` and `search_vault(mode:text)` generate trigram BM25 candidates from `notes_fts` and read ONLY the candidate files for the exact line/col verify — instead of `readFileSync`-ing every note in the vault per query. The disk scan remains the automatic fallback for sub-trigram queries (<3 chars), candidate-cap overflow, FTS-less adapters, and pre-reconcile boots, so behavior floor and hit shape are unchanged; scores become FTS bm25 values (never contractual). ACL filtering stays query-time on the caller's readable set.
- **Metadata tools read the notes table (THE-291, part 3B-ii).** `list_tags`, `find_notes_by_tag`, `list_properties`, and `find_notes_by_property` walked the vault and `readFileSync`'d every `.md` per call; once the boot reconcile's notes pass commits they aggregate from the `notes` table instead (ACL + folder filtering stay query-time; `tagMatches`/`typeOf`/`valueMatches` semantics reused verbatim in JS). The disk scan remains the automatic fallback pre-reconcile and in harnesses without the index. Two documented drifts: the `max_notes`/`limit` caps now apply in `ORDER BY path` order (the disk path used directory-walk order), and YAML-native dates surface as ISO strings via the JSON round-trip (matching the wire format).
- **Obsidian Bases expression DSL subset evaluator (THE-281).** `query_base` now EVALUATES bases written in the real Obsidian Bases expression language instead of refusing them (THE-284's honesty guard): a documented subset covering literals/lists, `file.*` (`name`/`path`/`folder`/`ext`/`tags`/`links`, `hasTag`/`inFolder`/`hasLink`), `note.<prop>` + bare-identifier shorthand, `formula.<name>`, the standard operators with `&&`/`||` short-circuit, string/list methods (`contains`/`startsWith`/`endsWith`/`isEmpty`/`lower`/`upper`/`trim`/`length`/`join`), globals (`if`/`date`/`now`/`today`/`min`/`max`/`list`/`number`), date±duration arithmetic, and `and`/`or`/`not` filter combinators. A pure-string top-level `filters` now selects the note set (real Bases has no `source` block). The honesty contract is unchanged where it matters: constructs OUTSIDE the subset (lambdas, bracket access, unknown methods/functions), trees MIXING DSL strings with JSONLogic objects, and unparseable string formulas all refuse with the typed `unsupported_base_filter` — never a silent match-all or a silent null column. obsidian-tc's own JSONLogic base model is untouched.
- **Bases model realigned to shipped Obsidian 1.12 syntax, additive-with-deprecation (THE-280).** `query_base` now HONORS the real per-view keys it previously round-tripped but ignored: `order` (namespaced `file.*`/`note.*`/`formula.*` ids project the columns when the deprecated `columns` alias is absent — `columns` wins in v1.x for back-compat), `sort` (strings or `{property, direction}` multi-key, stable), `limit` (caps the result set), and `groupBy` (or the deprecated `group` alias — rows gain an additive `group` key and group-major ordering). The document model declares the real top-level `filters` (the note set — real Bases has NO `source` block) and `properties`; `update_base` can now patch `filters`/`properties` (applied, not silently accepted), with `filters` HITL-gated exactly like the deprecated `source` alias; `create_base` surfaces `deprecations` notes when the obsidian-tc aliases (`source`, per-view `columns`/`group`) are used — all three are scheduled for removal at v2.0. Behavior note: a base that carried real Bases keys was previously queried as if they were absent; those keys now take effect (e.g. a stored `limit: 2` caps rows).
- **Companion installable-product hardening (THE-282).** (1) A server↔companion API-version floor: the companion's `/probe` already reports `obsidianTcApiVersion`; the server now compares it against `EXPECTED_COMPANION_API` and an incompatible companion degrades EVERY bridge tool with a new non-retryable `plugin_incompatible` error (+ update hint) instead of silently diverging — the companion's independent version cadence (deliberately excluded from version coherence) is unaffected. (2) `packages/plugin/versions.json` (version → `minAppVersion`, community-store requirement) now exists and is asserted by `check-version-coherence.mjs`; the plugin README documents that store submission needs the file at a plugin-repo ROOT. (3) The companion runs a startup shape self-check over the Obsidian internals it duck-types (`app.commands.listCommands`, `app.plugins.plugins`) — drift produces one `console.warn` and is surfaced on `/probe` as `shape_ok`/`shape_warnings`. (4) The README gains a reviewer-facing private-API inventory.
- **Live-Obsidian write coherence contract documented (THE-283).** A new `docs/COHERENCE.md` states the sole-agent-writer invariant (obsidian-tc's CAS gates are the defense against the remaining human-writer concurrency), the honest limits of Obsidian's external-change watcher (an open pane may not refresh until navigated; detection degrades on OneDrive/network drives), and the Windows rename-over-open-file semantics of the atomic temp+rename write (`MOVEFILE_REPLACE_EXISTING`; Obsidian holds no persistent note handles, so the residual risk is a transient `EPERM` surfaced as a visible write error, not silent loss). The opt-in companion refresh nudge is designed but deferred (private-API + needs a live app to verify).
- **Per-vault ACL (THE-295).** Each `vaults[]` entry may now carry its own `acl` block (same shape as the root `acl`: `readOnly`, read/write/delete glob whitelists, rules, `strictReadDefault`); the root ACL remains the inherited default, so existing configs are unchanged. Enforcement happens at dispatch: once the input names a vault (after the THE-267 vault-binding guard), the read-only kill switch and every handler-side `enforcePathAcl` run under that vault's ACL — "agent may write vault A but only read vault B" now works in ONE process. The advertised tool surface (per-caller `tools/list` filtering) deliberately keeps the caller's default ACL; enforcement is per-vault at dispatch.
- **SleepTime plane scheduler wired (THE-296).** The consolidation plane's synthesis + audit jobs existed and were tested but were never invoked from the server — two of three consolidation paths were dead runtime code. A new fully-defaulted `plane` config block (`enabled` default true, `intervalMinutes` default 240) starts an unref'd scheduler that runs every registered job, gated on the inference gateway being configured (the jobs degrade without it, but scheduling them then is pure DB churn). The README's retrieval-intelligence framing is de-scoped to match reality: machinery present and now scheduled; the GraphRAG ship-gate eval (recall@10) still needs an out-of-band run against a live embedding backend.
- **Asymmetric JWT verification — RS256/ES256/EdDSA + JWKS + kid rotation (THE-297).** `auth` gains optional `jwks` (inline JWKS document), `jwksFile` (loaded once at transport boot — file/inline only, deliberately no URL fetch), and `algorithms` (asymmetric allowlist, default RS256/ES256/EdDSA). The token's protected header routes verification: HS256 goes ONLY to the shared secret, asymmetric algs ONLY to the JWKS — the classic alg-confusion attack (public key as HMAC secret) is structurally impossible. Key rotation is `kid`-based inside the JWKS (publish old + new together). HS256-only deployments are byte-for-byte unchanged; `auth.mode: "jwt"` now accepts a JWKS in place of `jwtSecret`.
- **Sole-interface cutover guide (THE-279).** `docs/CUTOVER.md` documents replacing the LRA-MCP surface, mcp-tools, and obsidian-headless with obsidian-tc as the single agent interface: a verified capability map (every cited obsidian-tc tool grep-checked against the tool tree; UI-coupled gaps stated honestly — no active-file tools exist, `generate_uri` builds but never launches URIs), step-by-step cutover (install → per-vault ACL config → companion install via `obsidian-tc plugin install` → `server_health` verification → repoint Claude → retire the old plugins, keeping LRA only as the companion transport), config-only rollback, and the Sync story (obsidian-tc is filesystem-native and does not replace Obsidian Sync).
- **Docs, legibility + metadata polish (THE-299).** The README is reframed to lead with the actual problem (agents can wreck or leak a vault → governed access) and the triad facade as the headline UX (3 advertised tools, ~103 governed capabilities); absolutist claims are softened to dated/bounded phrasing; the competitor table's cyanheads row is corrected to its current shipped surface (~14 tools, folder-scoped paths, read-only, HITL, JWT/OAuth, 2025-11-25 pagination); the native module is honestly framed (cosine is the native win; tokenize/BM25 are the fallback scorer — the primary lexical rank is FTS5 `bm25()`); and a "when NOT to use obsidian-tc" section names honest alternatives. New `docs/QUICKSTART.md` (5-minute path) and `docs/WHY.md` (threat model + what governance means concretely). SECURITY.md gains a prompt-injection / hostile-vault-content section (mechanical ACL ≠ semantic obedience; retrieved content is untrusted; deny by ACL, not prompt). Metadata: `server.json`'s meaningless localhost `remotes` block is removed; the stale "domain is reserved" facade comment now reflects the shipped mode; the publish workflow gains CycloneDX SBOM artifacts (non-blocking with explicit warnings) beside the npm provenance attestations. The dev-dep audit freshen landed earlier (#113).
- **ARCHITECTURE.md truth pass (THE-298).** The 56KB architecture document no longer states superseded design as current: the Python ML sidecar (former component 14) and its IPC contract are DELETED (no sidecar code, config, or helper exists in the tree), the storage section documents the SHIPPED shared cache.db with logical vault_id isolation — including the exact table-by-table truth (which tables carry vault_id, that chunk_embeddings/vec_chunks are chunk-keyed with the THE-287 SQL-side vault scoping, and that vault_edges has no vault_id yet) — per the locked decision, with per-vault DB files documented as the planned V2 storage rewrite, and every stale site the adversarial review enumerated is fixed (per-vault-isolation bullets, HITL policy location, the companion probe apiVersion behavior now matching THE-282 reality, Docker entrypoint flags, component counts, dependency-chain rows). The auth, search, scheduler, and config sections are reconciled to everything shipped this cycle (THE-286..297).
- **Relicensed from Apache-2.0 to AGPL-3.0-only (THE-260).** Reciprocity on network re-hosting: anyone may run, modify, and self-host, but offering a modified obsidian-tc to others over a network requires releasing the source under the same terms. Prior tags (through v1.2.1) remain available under Apache-2.0; AGPL applies from this commit forward. Every license declaration updated (the four LICENSE files, all `package.json`, `Cargo.toml`, `manifest.json`, the README badge, and the image OCI labels).

### Security

- **`execute_template` honors `overwrite` — no more silent clobber (THE-289).** The Templater bridge tool forwarded `overwrite` but neither the server tool nor the companion `/templater/execute` route checked whether the target existed, so `create_new_note_from_template` (which writes `<target>.md`) could overwrite or duplicate an existing note with no confirmation. The server now refuses with `note_exists` when the resolved `<target>.md` already exists and `overwrite` is false (authoritative, independent of the companion version), and the companion route enforces the same as defense-in-depth. `overwrite: true` is unchanged.
- **HTTP tokens are now bound to a single vault (THE-267).** A bearer token may carry a `vault` claim; the HTTP edge binds the caller to that vault (or the server's default vault when the claim is absent), and `registry.dispatch` rejects any tool call whose `vault` argument names a different vault with `forbidden` — the same invariant `resources/read` already enforced. Previously any valid token could read, write, or delete every configured vault by passing its id, because the JWT carried no vault claim and the folder ACL is a single global instance. The trusted stdio transport is unaffected and retains full multi-vault access. Multi-vault HTTP deployments must now mint one token per vault (add a `vault` claim); a claimless token is confined to the server's default vault.
- **Fail-closed ACL defaults (THE-268).** The folder ACL now hard-denies `.obsidian/**`, `.git/**`, and `.trash/**` for read, write, and delete regardless of the allowlist (the two config files the bookmark/workspace tools use are exempted), so `read_note('.obsidian/plugins/*/data.json')` no longer leaks plugin API keys or Obsidian Sync passwords. `strictReadDefault` is now honored on the request path (`read_note` et al.), not just bridge enumeration, and was added to the config schema so setting it takes effect (it was previously stripped by validation). An undefined read/write whitelist otherwise remains allow-all by default (M0 back-compat).
- **DNS-rebinding / cross-origin protection on the HTTP transport (THE-271).** The Streamable-HTTP edge now rejects (403) a request whose `Host` is neither loopback nor operator-allowed, or whose `Origin` (browsers always send one; server-to-server MCP clients do not) is not the request's same origin or operator-allowed. Previously a malicious web page could POST to `http://127.0.0.1:<port>/mcp` and, under the `auth.mode:'none'` loopback default, receive full wildcard scopes. Configurable via `transports.http.enableDnsRebindingProtection` (default true), `allowedHosts`, and `allowedOrigins`.
- **Bridge tools fail closed under a read whitelist (THE-270).** `tasks_filter` no longer spreads its bridge `...result` (whose `groups` aggregate is computed over the UNFILTERED task set and leaked counts of notes outside the whitelist); `makemd_query` likewise drops its unfiltered `...result` siblings; both return only the ACL-filtered `items`. `list_templates` (template paths + parsed user-function bodies, plugin-defined and not reliably path-attributable) now refuses wholesale under a read whitelist, matching the `search_dql` fail-closed contract. No change when no read whitelist is configured.
- **Folder ACL checks are canonicalized through symlinks (THE-269).** The folder ACL matched the lexical request path while the filesystem followed in-vault symlinks, so a symlink under an allowed folder pointing at a denied (but in-vault) folder passed the ACL. `resolveVaultPath` now also exposes the real (symlink-resolved) vault-relative path, and every request-path `enforcePathAcl` call threads the vault root so the ACL gates the canonical path. Vault-root escape was already blocked; this closes the intra-vault read/write ACL-scope bypass. No effect on non-symlinked paths.

## [1.2.1] - 2026-06-26

Post-1.0.2 work, now versioned. Two strands landed on `main` after 1.0.2: a
security-audit remediation pass plus a dependency-currency sweep, and the
agent-ergonomics + distribution feature set merged 2026-06-26. `package.json` had
been bumped to 1.2.1 by the programmatic version path while this changelog,
`server.json`, and `manifest.json` lagged at 1.0.2; 1.2.1 is the first coherent cut
across all four. (1.1.0 and 1.2.0 were skipped by the bump path; release coherence is
tracked by THE-256.)

### Added

- **Tool-visibility scoping (THE-219):** config-driven `allowed` / `hidden` /
  `disabled` / `disabledTags` / `hiddenTags` / `requireReadOnly` filtering at the
  `tools/list` chokepoint, with `requireReadOnly` derived from existing mutation
  scopes. One build can serve a lean per-deployment surface without consolidating the
  tool set.
- **Per-caller tool-visibility filtering (THE-250):** the visibility layer also drops
  tools the authenticated caller lacks scopes for, composing with the static config
  rather than duplicating verdict logic.
- **Headless VaultBackend, lean v1 (THE-255):** a single filesystem `VaultBackend`
  (read / write / delete / exists / list / walk) serving reads and writes in both live
  and headless modes; `resolveMode` (probe-once, per vault) and `assertLive` returning a
  typed `requires_live_obsidian` for action-firing tools when Obsidian is closed.
- **Distribution artifacts (THE-220):** `server.json` (MCP registry,
  `io.github.The-40-Thieves/obsidian-tc`), `manifest.json` (MCPB 0.3), `.mcpbignore`, and
  `scripts/bundle-mcpb.ts` for one-click `.mcpb` install, plus Cursor / VS Code deeplinks
  in the README.

### Security

- **Read-ACL bypass closed:** `search_dql` / `search_vault(mode:dql)` returned whole-vault
  Dataview rows with no read-ACL intersection; now refused under a read whitelist
  (fail-closed), mirroring the other bridge tools.
- **ReDoS guard hardened:** the regex guard now also rejects a quantifier applied to an
  alternation (e.g. `(a|a)+`), closing the previous bypass.
- **Delete-class tools are now rate-limited** (a `delete` throttle tier was missing).
- **Internal errors no longer leak the absolute vault path** to MCP callers.

### Fixed

- **Frontmatter fidelity:** writes preserve untouched YAML keys byte-for-byte, so
  leading/trailing-zero values (zip codes, ISBNs, semver) survive any write, including
  body-only `patch_note` edits.
- **`bulk_move_notes`:** in-batch destination collisions and chained moves are rejected
  instead of silently clobbering/losing content.
- Tokenizer parity (Rust `is_alphanumeric` vs JS `\p{Alphabetic}`), `reset_vault_cache`
  drops orphaned sqlite-vec vectors, a corrupt idempotency cache self-heals, jsonlogic
  has a depth cap, and embedding vectors are finite-checked.

### Changed

- **Dependency-currency sweep:** Zod 3 → **4** (dropped the deprecated `zod-to-json-schema`
  for native `z.toJSONSchema`), Biome 1.9 → **2.5**, napi-rs 2 → **3**, better-sqlite3 11 → **12**,
  @types/node 22 → **24**, esbuild 0.24 → **0.25**.
- **Standardized on Node 24 LTS:** `engines.node >=24` and CI on Node 24 across the board.

## [1.0.2] - 2026-06-21

Security patch. Closes the unauthenticated-bind exposure present in 1.0.1 and
rolls up the post-1.0.1 rate-limiter and housekeeping work already on `main`.

### Security

- **F2: the HTTP transport now refuses to bind a non-loopback host when
  `auth.mode` is `none`.** Enforced fail-closed at config load with no insecure
  override; loopback detection is centralized in a shared `net-host` helper with
  strict IPv4 octet validation and bracket-normalized IPv6 binding. 1.0.1 could
  serve an unauthenticated vault on a non-loopback address. (THE-113 audit, F2.)

### Fixed

- **F1: the native build no longer clobbers its prebuild output directory.**
- **F4 / F8 and audit hygiene** from the THE-113 end-to-end audit; the committed
  audit report is removed from the tree.
- Rate limiter: single deletes tier at the `delete` scope class (THE-212) and
  idle buckets are reclaimed (THE-213).

### Changed

- Docs reconciled to the access-only V2 framing and freshened post-1.0.1;
  tool-surface count corrected to 103 across 28 domains (THE-217).

### CI

- Pure-JS native fallback test job (THE-216) and a decoupled `release-image`
  workflow for GHCR-only image re-releases.

## [1.0.1] - 2026-06-19

First public release: a comprehensive, model-agnostic, agent-ready Obsidian MCP server —
the full v1.0 tool surface (G2.1 Domains 1–28, 103 tools) plus the M7 hardening gate.

### Added

- **Tool surface (Domains 1–28)** — notes / metadata / links, search + embeddings, structured
  formats (bases, canvas, periodic), plugin-bridge tools, memory + capture, bulk operations,
  URI generation, and the server-admin surface.
- **Observability (G2.4)** — OpenTelemetry traces (conditional; a no-op until an OTLP endpoint
  is configured), the Prometheus catalog (8 counters / 2 histograms / 4 gauges) exposed via an
  optional `/metrics` scrape endpoint, and a MORGIANA CloudEvents 1.0 JSONL spool (9 event
  types). All export streams fail soft and never block tool execution.
- **Dispatch-wide rate limiting (THE-210)** — a deterministic token-bucket policy gate across
  every scope class (read / write / bulk / execute / admin) with the G2.4 tiered defaults.
- **Security model (G2.4)** — HS256 JWT auth, scope + folder ACLs, HITL elicitation with
  hardcoded floors, a shared response-byte governor, and a localhost-only-by-default posture.
- **Native module** — napi-rs vector / BM25 primitives with a pure-JS fallback. v1.0 ships
  prebuilds for 4 platforms (linux-x64-gnu, darwin-x64, darwin-arm64, win32-x64-msvc).
- **Distribution** — a tag-triggered release workflow (npm with `--provenance`, standalone Bun
  binaries, plugin zip, multi-arch Docker image), Apache-2.0 licensed, with an Astro Starlight
  documentation site.

### Deferred to v1.1

- `linux-arm64` native prebuilds (the pure-JS fallback covers arm64-linux), cosign binary
  signing, and CycloneDX SBOM generation.
- The richer `obsidian-tc serve / init / auth / …` subcommand CLI (G2.5 §5); v1.0 ships a
  config-path launcher.

[1.0.0]: https://github.com/The-40-Thieves/obsidian-tc/releases/tag/v1.0.0
