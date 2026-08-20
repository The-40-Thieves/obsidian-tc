---
title: Configuration Reference
description: Every configuration key, its type, default, and whether it's required — generated from the Zod schema.
sidebar:
  order: 9
---

Every configuration key obsidian-tc understands, generated from the Zod schema so it stays in sync
with the server. For task-oriented guidance on setting these, see the
[config.yaml guide](/configuration/config-yaml/).

:::tip
Only `vaults` is strictly required — everything else has a sensible default. A minimal config is just
`{ "vaults": [{ "id": "main", "path": "/path/to/vault" }] }`.
:::

:::note
Generated (`bun run docgen:render`); do not hand-edit the region between the markers.
:::

<!-- BEGIN GENERATED: config -->
### `acl`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `acl.defaultScopes` | `array<string>` | `[]` |  | Scopes REQUIRED to operate on a path that matches no rule (P1.4). Empty (the default) adds no requirement. |
| `acl.deletePaths` | `array<string>` | — |  | Glob whitelist for deletes: a path must match at least one entry. Omitted leaves deletes unrestricted. |
| `acl.readOnly` | `boolean` | `false` |  | Reject every mutating operation on this vault regardless of the scopes a caller holds. |
| `acl.readPaths` | `array<string>` | — |  | Glob whitelist for reads: a path must match at least one entry. Omitted leaves reads unrestricted (see strictReadDefault). |
| `acl.rules` | `array<object>` | — |  | Ordered glob-to-required-scope rules enforced at dispatch (P1.4). Later matches override earlier ones. |
| `acl.rules[].glob` | `string` | — | **yes** | Glob matched against the vault-relative note path. |
| `acl.rules[].scopes` | `array<string>` | `[]` |  | Scopes REQUIRED to operate on paths matching this rule (P1.4): a caller must hold every listed scope, in addition to the tool's own required scopes, to read/write/delete a matching path. The LAST matching rule wins, replacing rather than merging the scopes of earlier matches. An empty list adds no requirement. Enforced at dispatch on tool operations; it does not filter search/enumeration result visibility, which is governed by readPaths. |
| `acl.strictReadDefault` | `boolean` | `false` |  | When true, an UNDEFINED readPaths whitelist fails CLOSED on the request path rather than only on bridge enumeration. Default false preserves allow-all back-compatibility. |
| `acl.writePaths` | `array<string>` | — |  | Glob whitelist for writes: a path must match at least one entry. Omitted leaves writes unrestricted. |

### `auth`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `auth.algorithms` | `array<string>` | — |  | Explicit allowlist of accepted JWT algorithms. Algorithm confusion is structurally impossible regardless: HS256 verifies only against jwtSecret and asymmetric algorithms only against the JWKS. |
| `auth.audience` | `union` | — |  | Expected `aud` claim. Binding it rejects a token an issuer minted for a DIFFERENT service (confused deputy). Required with a JWKS or a non-loopback bind; defaults to `resource` when Protected Resource Metadata is configured. |
| `auth.authorizationServers` | `array<string>` | — |  | Authorization server issuer URLs advertised in the Protected Resource Metadata document. At least one is needed for PRM to be served. |
| `auth.issuer` | `string` | — |  | Expected `iss` claim. Setting it also requires an audience — validating the issuer alone does not establish that the token was meant for this server. |
| `auth.jwks` | `record` | — |  | Inline JWKS document for asymmetric verification (RS256/ES256/EdDSA). Rotation is multiple keys in the set, selected by the token's `kid`. |
| `auth.jwksFile` | `string` | — |  | Path to a JWKS document, loaded once at transport boot. Adds no network dependency; prefer it over jwksUri when the keys are static. |
| `auth.jwksUri` | `string` | — |  | URL of an authorization server's JWKS (its `jwks_uri`), fetched and cached for asymmetric verification. Opt-in: it adds a network dependency to token verification, which jwks/jwksFile do not. Use it when an external AS rotates keys. |
| `auth.jwtSecret` | `string` | — |  | Shared secret for HS256 verification, minimum 32 characters. Secret. HS256 tokens verify ONLY against this, never against the JWKS. |
| `auth.mode` | `enum(none\|jwt)` | `"none"` |  | Authentication mode. `none` grants every request full wildcard scopes and is refused on a non-loopback HTTP bind; `jwt` requires a jwtSecret or a JWKS. |
| `auth.resource` | `string` | — |  | This server's canonical resource URI (RFC 9728). Set together with authorizationServers to advertise Protected Resource Metadata; also serves as the default bound audience. |
| `auth.resourceName` | `string` | — |  | Human-readable resource name published in the Protected Resource Metadata document. |
| `auth.scopesSupported` | `array<string>` | — |  | Scopes advertised as supported in the Protected Resource Metadata document. |
| `auth.tokenTtlSeconds` | `number` | `86400` |  | Maximum accepted token AGE in seconds, measured from the token's `iat`. This caps age INDEPENDENTLY of `exp`: a token with a one-year expiry is still rejected once it is older than this, so a long-lived credential needs this raised to match. |

### `bootstrap`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `bootstrap.deepPaths` | `array<string>` | `[]` |  | Context notes loaded additionally in deep mode. |
| `bootstrap.deepPhrases` | `array<string>` | `["where did we leave off","what's open","whats open","catch me up","current state","where are we","what should i be working on","what should i work on"]` |  | Catch-up phrases that force deep mode regardless of the triage result. |
| `bootstrap.domains` | `array<object>` | — |  | Signal-to-path routing table. Empty means the tool degrades to lightweight with nothing to load. |
| `bootstrap.domains[].name` | `string` | — | **yes** | Label for this routing domain. |
| `bootstrap.domains[].paths` | `array<string>` | — | **yes** | Context notes loaded when this domain matches. |
| `bootstrap.domains[].signals` | `array<string>` | — | **yes** | Lowercased substrings; the domain matches when any one appears in the opening message. |
| `bootstrap.maxPaths` | `number` | `10` |  | Ceiling on how many context notes one bootstrap may read. |

### `cacheDir`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `cacheDir` | `string` | `".obsidian-tc"` |  | Directory holding the derived index and caches. Everything in it is regenerable — deleting it forces a full reindex, it is never the source of truth. |

### `elicitTtlSeconds`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `elicitTtlSeconds` | `number` | `300` |  | Seconds a pending elicitation (human-in-the-loop prompt) stays valid before it expires. |

### `embeddings`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `embeddings.apiKey` | `string` | — |  | Provider API key. Secret — never logged or returned by a tool. |
| `embeddings.apiKeyEnv` | `string` | — |  | Name of the environment variable holding the provider API key. Needed for generic providers, which have no entry in the built-in per-vendor variable map. An inline apiKey takes precedence. |
| `embeddings.baseUrl` | `string` | — |  | Provider base URL. Required for self-hosted runners; hosted providers default to their public API. |
| `embeddings.batchSize` | `number` | `512` |  | Maximum inputs per embed request. |
| `embeddings.chunkContext` | `boolean` | `true` |  | Embed and BM25-index each chunk as "{title}{ — heading breadcrumb}\\n\\n{content}" rather than bare section text, so title- and heading-only evidence is visible to both retrieval streams. Displayed content stays raw. The chunk hash covers the enriched text, so changing this re-embeds the vault on the next reconcile. |
| `embeddings.concurrency` | `number` | `4` |  | How many embed requests run in flight at once. |
| `embeddings.dimensions` | `number` | `768` |  | Stored vector width, and the width of the vec0 column. Changing it requires a fresh index — existing vectors are not re-projected. |
| `embeddings.documentPrefix` | `string` | `""` |  | Instruct prefix prepended to document-side (indexing) embeds. Empty by default. Changing it re-embeds nothing on its own, since hashes cover chunk text and not the prefix — pair a change with a fresh cacheDir. |
| `embeddings.maxBatchTokens` | `number` | `2048` |  | Estimated-token ceiling per request (chars/4), splitting a dense sub-batch before it overruns a local runner's budget. Must stay UNDER the provider's loaded context: Ollama defaults to n_ctx 4096 and rejects an over-budget request, and the chars/4 estimate undercounts real tokenization on link-dense markdown. |
| `embeddings.model` | `string` | `"nomic-embed-text"` |  | Embedding model name as the provider names it. |
| `embeddings.modelTier.dense.baseUrl` | `string` | — | **yes** | Base URL of the dense (Qwen3 via Rust TEI) embedding service. |
| `embeddings.modelTier.dense.model` | `string` | `"Qwen/Qwen3-Embedding-0.6B"` |  | Dense model id. Its width is what embeddings.dimensions must match. |
| `embeddings.modelTier.dense.pooling` | `string` | `"last-token"` |  | Pooling strategy for the dense model. |
| `embeddings.modelTier.dense.revision` | `string` | — |  | Pinned model revision for the dense service. PROVENANCE ONLY: it moves neither provider.id nor vec_index_fingerprint, so changing it does not rebuild the index. Use the top-level embeddings.revision to force a re-embed — it applies to model-tier too. |
| `embeddings.modelTier.full.authToken` | `string` | — |  | Bearer token for the multi-vector service. Secret. |
| `embeddings.modelTier.full.baseUrl` | `string` | — | **yes** | Base URL of the multi-vector (BGE-M3) service. |
| `embeddings.modelTier.full.dimensions` | `number` | `1024` |  | Dense width of the multi-vector model, separate from embeddings.dimensions. |
| `embeddings.modelTier.full.model` | `string` | `"BAAI/bge-m3"` |  | Multi-vector model id. |
| `embeddings.modelTier.full.revision` | `string` | — |  | Pinned model revision for the multi-vector service. PROVENANCE ONLY: it moves neither provider.id nor vec_index_fingerprint, so changing it does not rebuild the index. Use the top-level embeddings.revision to force a re-embed — it applies to model-tier too. |
| `embeddings.modulePath` | `string` | — |  | Module exporting createEmbeddingProvider, for provider 'module'. Resolved against the config file's directory. Refused under the hardened security profile, and refused on CLI/eval entry points (module providers load only from the server's boot wiring). The factory may be sync or async (an async factory is awaited). It must return an object with a non-empty string id, provider, and model — id is what chunk_embeddings.model and the vec fingerprint identify the provider by, so two module providers sharing (or omitting) id are indistinguishable to the index — a positive integer dimensions, and embed(texts). Validated at load time, before first use. |
| `embeddings.pooling` | `string` | — |  | Pooling strategy the backend applies (e.g. 'mean', 'last-token'). Folded into the representation identity persisted as vec_index_fingerprint, so changing it rebuilds the vector index rather than serving vectors pooled a different way against queries pooled the new way. The rebuild reuses the stored embeddings — it does not re-embed, and costs no provider calls. |
| `embeddings.provider` | `string` | `"ollama"` |  | Embeddings backend name, resolved against the provider registry at startup. Built-ins: ollama, openai, voyage, cohere, bge-m3, model-tier (splits dense and multi-vector across two services), the generic openai-compatible, and the profile-gated module. An unregistered name is a startup error listing every valid option. |
| `embeddings.queryPrefix` | `string` | `""` |  | Instruct prefix prepended to query-side embeds, for models whose cards require one. Empty by default — such prefixes measured harmful on this corpus. |
| `embeddings.revision` | `string` | — |  | Model revision / commit / checkpoint id. Folded into vec_index_fingerprint, so declaring it makes a checkpoint upgrade at the SAME model name and width rebuild the index instead of silently serving the old checkpoint's vectors against queries embedded by the new one. Omitting it reproduces today's behaviour exactly. |
| `embeddings.timeoutMs` | `number` | `120000` |  | Timeout in ms for a single embed request. Defaults high because local runners are far slower than hosted APIs. |
| `embeddings.truncate` | `boolean` | `false` |  | Matryoshka (MRL) truncation: accept a provider vector WIDER than `dimensions` by keeping the first `dimensions` components and renormalising. Off by default so a non-MRL width mismatch errors instead of silently storing a meaningless prefix. |

### `experiential`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `experiential.activationDecay` | `number` | `0.5` |  | ACT-R decay exponent for the activation recompute. Weight falls as days ** -decay, so HIGHER means faster forgetting: ~0.3 for a reference vault where month-old notes still count, 0.5 (default, the ACT-R literature value), ~0.8 for a journal where last week is what matters. |
| `experiential.activationRerank` | `boolean` | `false` |  | Apply the ACT-R cached-activation-score signal to graph search ranking: builds the lookup, threads it to every M7 graphSearch call, and enables the bounded bubble pass that composes it into the fused order (each item moves at most one position). Ships off; the A/B that would justify turning it on is THE-424 Part B. |
| `experiential.captureContent` | `boolean` | `true` |  | Also persist each episode's raw parsed arguments, secret-scanned and size-capped, so work-memory carries what a call actually did rather than only that it happened. On under the trusted-local posture; `securityProfile: "hardened"` turns it off, as does setting it false explicitly. |
| `experiential.captureEpisodes` | `boolean` | `true` |  | Record every dispatch outcome as an agent_episodes row — tool, status, duration, sizes, hashes, attribution. No payloads are stored. |
| `experiential.citationInfer.enabled` | `boolean` | `false` |  | Run the citation-inference pass on a schedule over a transcript index. Off by default: it needs transcriptIndex, an input no MCP surface can produce on its own. |
| `experiential.citationInfer.intervalHours` | `number` | `6` |  | Hours between scheduled passes when enabled. Defaults to 6: the pass costs gateway judge calls, and a retrieval's citation status is not time-sensitive once stamped. |
| `experiential.citationInfer.transcriptIndex` | `string` | — |  | Path to a JSONL transcript index — one object per retrieval ({vault, surface_type, query, retrieved_at, transcript}), whose transcript is already filtered to text produced AFTER retrieved_at. Absent disables the scheduled pass entirely. |
| `experiential.citationPreferences` | `boolean` | `false` |  | Fold chunk_retrievals citation verdicts (citation_state / cited_in_response) into the deterministic preferred.search_mode preference counter, alongside episode task_result evidence: a search-family tool whose retrievals are CONFIRMED cited strengthens the key, one whose retrievals are REJECTED weakens it. Off by default — ranking-adjacent, needs a pre-registered eval before defaulting on. Needs citationInfer.enabled (or another citation_state producer) to have any effect. |
| `experiential.gapSweep.enabled` | `boolean` | `false` |  | Run the coverage-gap sweep on a schedule, persisting a gap_reports row the gap_report tool can read back. Off by default: each swept query costs an embedding call plus a search. |
| `experiential.gapSweep.intervalHours` | `number` | `168` |  | Hours between sweeps when enabled. Defaults to weekly — a coverage gap is a slow-moving property of the corpus, not something worth re-measuring hourly. |
| `experiential.gapSweep.maxQueries` | `number` | `50` |  | Upper bound on queries per sweep. The sweep draws the most recent DISTINCT logged queries from chunk_retrievals, so this caps both gateway cost and how far back a single pass reaches. |
| `experiential.logRetrievals` | `boolean` | `true` |  | Append serve-path retrieval events (chunk id, rank, score, query text, surface) to experiential.db. Local-only telemetry feeding activation recompute and usage stats; eval runs never log. |
| `experiential.proactive.dismissalPenalty` | `number` | `1` |  | Budget removed per dismissal (a -1 stamped through record_retrieval_feedback on an advisory row). At 1, five dismissals exhaust a maxPerSession of five. |
| `experiential.proactive.enabled` | `boolean` | `false` |  | Run the scheduled proactive-advisory sweep: score recent vault activity (changed notes, open contradictions, recent syntheses) against open goals and surface the top candidates to connected sessions. Off by default — see the block-level comment for why this is a precision decision, not only a cost one. |
| `experiential.proactive.maxPerSession` | `number` | `5` |  | Hard cap on advisories a single session may receive in total before dismissal decay reduces it further. |
| `experiential.proactive.minScore` | `number` | `0.6` |  | Below this goal-similarity score, a candidate is not worth interrupting for. Precision over recall — the ticket's phrase, not a paraphrase. |
| `experiential.proactive.topK` | `number` | `2` |  | Hard cap on advisories surfaced per sweep, per session. The ticket: "Surface the top 1-2 items, never a digest." |

### `gateway`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `gateway.baseUrl` | `string` | — |  | Inference gateway base URL. Takes precedence over the OBSIDIAN_TC_GATEWAY_URL environment variable when both are set — set this when a host application rewrites its own env block on restart, which would otherwise silently drop the env var and degrade every generative seam with no error. Absent falls through to the env var, then to graceful degradation. |
| `gateway.token` | `string` | — |  | Bearer token (LiteLLM master/virtual key) for the gateway. Secret — never logged, and takes precedence over the OBSIDIAN_TC_GATEWAY_TOKEN environment variable when both are set. |

### `governor`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `governor.maxResponseBytes` | `number` | `1000000` |  | Ceiling on a single tool or resource response in bytes, before it is refused (THE-514: resources/read honors this too, not just tools). |
| `governor.regexTimeoutMs` | `number` | `2000` |  | Worker-time budget in ms for one regex search. Only regex execution counts — file I/O does not — so a benign pattern over a large vault cannot false-positive the ReDoS guard. |

### `idempotencyReclaimSeconds`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `idempotencyReclaimSeconds` | `number` | `60` |  | Seconds after which a crashed in-flight idempotency row may be reclaimed at dispatch. Raise it for legitimately slow bulk tools: setting it below a live tool's runtime risks executing that tool twice. |

### `idempotencyTtlSeconds`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `idempotencyTtlSeconds` | `number` | `86400` |  | Seconds an idempotency record is retained, bounding how long a repeated request key is deduplicated. |

### `indexing`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `indexing.chunkTokens` | `number` | `512` |  | Chunker token budget: a note section over this many estimated tokens is sub-split on paragraph boundaries. Participates in the representation fingerprint, and unlike the other axes a change here requires a full re-index — different budget means different chunk boundaries, so stored vectors no longer describe any chunk that exists. |
| `indexing.queueMax` | `number` | `1000` |  | Soft cap on distinct pending paths, surfaced as backpressure in server_health. Writes are never dropped when it is exceeded. |
| `indexing.streamingWalk` | `boolean` | `false` |  | Walk the vault lazily per-directory (walkVaultStream) instead of materializing the full sorted file list before indexing starts. Lower peak memory on large vaults; index output is unchanged either way. |
| `indexing.writeConcurrency` | `number` | `8` |  | Ceiling on concurrent index/embed calls across ALL vaults. |
| `indexing.writeConcurrencyPerVault` | `number` | `4` |  | Ceiling on concurrent index/embed calls for a single vault. |

### `maintenance`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `maintenance.enabled` | `boolean` | `true` |  | Run the periodic cache.db maintenance sweep (expired idempotency and elicitation rows, event_log retention, PRAGMA optimize). |
| `maintenance.episodesRetentionDays` | `number` | `90` |  | Days a DEAD agent_episodes row (a forget tombstone, or one whose valid_until has passed) is retained before the maintenance sweep prunes it. Live episodes are never pruned at any age. Keep this long enough to still answer 'was this forgotten?' after the fact. |
| `maintenance.intervalMinutes` | `number` | `60` |  | Minutes between maintenance sweeps. |
| `maintenance.jobsCompleteRetentionDays` | `number` | `7` |  | Days a COMPLETE job row is retained before the maintenance sweep prunes it. Must stay LONGER than the longest producer dedup window: enqueue() dedups against a terminal row unless replaceIfTerminal is set, so pruning one frees its idempotency key and lets that period run again (the weekly synthesis is the longest today). |
| `maintenance.jobsFailedRetentionDays` | `number` | `30` |  | Days a FAILED (dead-lettered) job row is retained. Longer than the complete-row window because these exist to be read; bounded by age, so a burst of failures inside the window is still unbounded in count. |
| `maintenance.reconcileIntervalMinutes` | `number` | — |  | Minutes between periodic full vault reconciles. ABSENT (the default) disables it: the boot reconcile and the filesystem watch already cover a healthy server. Set it when the watch cannot run — a network mount with no change notification, or a vault large enough to exhaust the inotify limit — and when derived graph edges should be refreshed, since single-note writes never densify. Costs a full vault walk per run; content-hash skip makes an unchanged vault cheap to re-walk but densification still runs. |
| `maintenance.retrievalsRetentionDays` | `number` | `365` |  | Days a chunk_retrievals row is retained. NOT purely disk hygiene: chunk_access_stats is a VIEW over this table, so pruning REWRITES access_count / last_accessed_at / citations / observed, which feed activation and note quality. A short window makes a long-tail note that was genuinely useful look never-accessed. The default is deliberately a year, far above the other retention windows, so no signal any current consumer reads is affected. |

### `observability`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `observability.morgiana.httpEndpoint` | `string` | — |  | Push CloudEvents to this URL. Absent means spool-only, with no network calls. |
| `observability.morgiana.httpHeaders` | `record` | `{}` |  | Extra headers sent with event pushes. Values may be secret. |
| `observability.morgiana.spool` | `boolean` | `true` |  | Write CloudEvents to a local JSONL spool file. |
| `observability.otel.endpoint` | `string` | — |  | OTLP collector endpoint. OpenTelemetry export is a no-op until this is set. |
| `observability.otel.headers` | `record` | `{}` |  | Extra headers sent with OTLP exports, e.g. an auth token. Values may be secret. |
| `observability.prometheus.bind` | `string` | `"127.0.0.1"` |  | Bind address for the scrape endpoint. Loopback by default — /metrics is unauthenticated. |
| `observability.prometheus.enabled` | `boolean` | `false` |  | Serve the Prometheus /metrics endpoint. |
| `observability.prometheus.port` | `number` | `9464` |  | Port for the Prometheus scrape endpoint. |
| `observability.retention.eventLogDays` | `number` | `30` |  | Days of event_log rows kept by the maintenance sweep. The morgiana event spool is still not pruned and grows without bound. |
| `observability.retention.tracesDays` | `number` | `30` |  | Days of workspace session trace files (<vault>/<traceFolder>/*.jsonl) kept by the maintenance sweep. Traces are per-vault and live INSIDE the vault, so they are also picked up by whatever syncs or backs it up. Orphans from a failed start_session are pruned by the same age rule (THE-572 writes the trace before the session row, so a failed attempt leaves a file with no row referencing it). |

### `personas`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `personas` | `record` | — |  | Named persona bundles ({vaults, scopes, toolVisibility?}) a JWT's `persona` claim resolves to. Absent means no personas are configured — any token carrying a `persona` claim is refused. |

### `plane`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `plane.enabled` | `boolean` | `false` |  | Run ambient sleep-time consolidation (synthesis and audit jobs). Only meaningful when the inference gateway roles are configured. Opt-in (THE-825): a deployment with a gateway configured and this key unset gets a boot-time notice explaining how to turn it on. |
| `plane.gatewayMaxAttempts` | `number` | `6` |  | Attempts a consolidation job's gateway call may make before failing, each with its own fresh timeout. Higher than the interactive default (3) because the models behind the gateway roles may be serverless and scale to zero: a cold start measured at over 180s exceeded 3 attempts x 60s, so every scheduled pass failed with a timeout while the same request against a warm endpoint took 4.8s. Separate from the interactive path on purpose: a multi-minute budget suits a background weekly pass and not a user-facing call. NOTE (THE-709): attempts alone were not sufficient — retries only help a TRANSIENT failure, and a request that deterministically exceeds the per-attempt timeout fails identically on every attempt. See planeGatewayTimeoutMs, which is the knob for that case. |
| `plane.gatewayTimeoutMs` | `number` | `300000` |  | Per-ATTEMPT request timeout in ms for a consolidation job's gateway call, separate from the interactive 60s default. Raising ATTEMPTS (gatewayMaxAttempts) cannot rescue a call that is simply slow: a synthesis pass measured 370.4s and 370.4s on two runs 45 minutes apart — 6 attempts x 60s plus backoff, identical to within 12ms, which is a client budget expiring rather than a varying cold start. The endpoint was warm throughout (a small completion through the same gateway answered in 360ms), so nothing was being waited out; one attempt simply could not finish inside 60s. A synthesis-sized request measured 28.9s for 9,422 prompt tokens and only 473 completion tokens, and generation dominates, so a pass emitting a few thousand tokens crosses 60s comfortably. The default is generous because this workload is latency-tolerant by construction — a weekly consolidation pass has no user waiting on it — while the interactive seam keeps 60s, where a multi-minute stall would be a hang. Lower it only if a stuck job holding a worker for minutes matters more than the pass completing. |
| `plane.intervalMinutes` | `number` | `240` |  | Minutes between consolidation passes. |
| `plane.maxPromptChars` | `number` | `60000` |  | Aggregate character cap on a consolidation job's WHOLE gateway request (system prompt + user message). Not a per-item cap: the synthesis job already truncated each chunk to 1000 chars and still built a 169,258-char prompt from 200 of them, which the serving window rejected as ContextWindowExceeded. Sized in characters, not tokens, because no tokenizer is available on this side. The default is conservative on purpose — the model behind a gateway role is swappable at the gateway, and the server does not advertise its max_model_len through the LiteLLM /v1/models passthrough, so this side cannot discover the real ceiling. Measured on a real vault at 3.294 chars/token, 60000 is ~18.2k tokens; dense content (code, CJK) runs nearer 2.5 chars/token, giving ~24k. Both leave room for the model's own output inside a 32768 window. Raise it when the role points at a larger serving window. |

### `plur`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `plur.apiKey` | `string` | — |  | Bearer token for the plur read API. Secret — placed only in the Authorization header, never logged or included in an error or audit payload. |
| `plur.apiPrefix` | `string` | `""` |  | Path prefix prepended to plur API routes. |
| `plur.command` | `array<string>` | — |  | argv prefix for shelling out to a local plur CLI instead of the HTTP endpoint, e.g. ["plur"]. Takes precedence over `endpoint`. |
| `plur.endpoint` | `string` | — |  | Base URL of the plur read API. When absent (and no `command` is set) the plur tools degrade to plugin_missing with NO network call. |
| `plur.timeoutMs` | `number` | `5000` |  | Timeout in ms for a plur read call. |

### `ranking`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `ranking.metadataPrior.clampFraction` | `number` | `0.5` |  | Cap the absolute total boost per result at this fraction of the observed fused-score spread. Below 1 this guarantees the prior stays a tie-break: a fully boosted bottom result still cannot overtake the top base-scored one. |
| `ranking.metadataPrior.enabled` | `boolean` | `false` |  | Apply the frontmatter authority-boost overlay after fusion. |
| `ranking.metadataPrior.rules` | `array<object>` | — |  | Field/value/boost rules summed for each result before the list is re-sorted. |
| `ranking.metadataPrior.rules[].boost` | `number` | — | **yes** | Amount added to the fused score on a match. May be negative, which makes the rule an archive-style penalty. |
| `ranking.metadataPrior.rules[].field` | `string` | — | **yes** | Frontmatter field name to test on a candidate note. |
| `ranking.metadataPrior.rules[].value` | `string` | — | **yes** | Value that frontmatter[field] must equal for the boost to apply. |

### `readwise`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `readwise.token` | `string` | — |  | Readwise access token (readwise.io/access_token), used as `Authorization: Token <token>` against the classic v2 export API. Secret — never logged or placed in an error/audit payload. Absent means `import-highlights` no-ops with NO network call. |

### `reranker`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `reranker.apiKey` | `string` | — |  | Provider API key. Secret — never logged. Ignored — and refused at boot if set — by model-tier, which sources auth from embeddings.modelTier.full.authToken. |
| `reranker.apiKeyEnv` | `string` | — |  | Environment variable holding the API key. Inline apiKey wins. Ignored — and refused at boot if set — by model-tier (see apiKey). |
| `reranker.baseUrl` | `string` | — |  | Endpoint prefix preceding /rerank. Include the dialect version segment: Cohere rerank v2 replaced v1's max_chunks_per_doc with max_tokens_per_doc, and this prefix selects the dialect. Ignored — and refused at boot if set — by model-tier, which sources its endpoint from embeddings.modelTier.full.baseUrl. |
| `reranker.localModelPath` | `string` | — |  | Absolute path to the local cross-encoder model directory for provider 'local' (containing <model-id>/config.json, tokenizer.json, onnx/model_int8.onnx — see @the-40-thieves/obsidian-tc-reranker-local's README). Defaults to that package's own models/ directory, populated by its `bun run fetch-model` script. Ignored — and refused at boot if set — by every other provider. |
| `reranker.localModulePath` | `string` | — |  | Explicit path to @the-40-thieves/obsidian-tc-reranker-local's BUILT module entry (its dist/index.js), for provider 'local'. Absolute, or resolved against the config file's directory (same convention as modulePath). Tried FIRST, before the bare package specifier and the source-checkout default — see that package's README for when you need this. Ignored by every other provider. |
| `reranker.model` | `string` | — |  | Rerank model name as the provider names it. Required by cohere-compatible (refused at boot if absent). Ignored — and refused at boot if set — by model-tier, which sources its model from embeddings.modelTier.full.model. Optional for gateway: omitting it silently falls back to the model literal "rerank". |
| `reranker.modulePath` | `string` | — |  | Module exporting createReranker, for provider 'module'. Resolved against the config file's directory. Refused under the hardened security profile. The factory may be sync or async (an async factory is awaited). It must return a function: (query, documents, topN) => Promise<RerankHit[]>. Validated at load time, before first use. |
| `reranker.provider` | `string` | — | **yes** | Reranker backend name, resolved against the provider registry at startup. Built-ins: cohere-compatible (any Cohere-format /rerank endpoint), model-tier (the BGE cross-encoder, configured via embeddings.modelTier.full), gateway (the inference gateway passthrough), local (THE-705: a bundled, fully offline cross-encoder — no gateway or Python service required; requires the optional @the-40-thieves/obsidian-tc-reranker-local package), and the profile-gated module. |
| `reranker.timeoutMs` | `number` | — |  | Timeout in ms for a single rerank request. Ignored — and refused at boot if set — by model-tier, which uses embeddings.timeoutMs instead. |

### `retrieval`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `retrieval.adaptiveRrf.enabled` | `boolean` | `false` |  | Enable the adaptive per-stream RRF weighting tilt. Off by default. |
| `retrieval.adaptiveRrf.gain` | `number` | `0.5` |  | Strength of the tilt, clamped to [0,1] so stream weights stay within [0,2] — an over-unity gain would drive a weight negative and invert its ranking rather than just reweight it. |
| `retrieval.cache.enabled` | `boolean` | `false` |  | Cache query encodings and graph-search results in process, keyed by vault generation + caller ACL fingerprint + query + retrieval config. A latency optimisation only; off by default. |
| `retrieval.cache.maxEntries` | `number` | `64` |  | Maximum live entries per cache (results and query encodings are counted separately). Results carry chunk content, so this is the memory bound. |
| `retrieval.cache.ttlSeconds` | `number` | `60` |  | Entry lifetime. Bounds staleness from inputs the key cannot see: wall-clock recency decay, and derived state (densified edges, activation scores) written by jobs that do not bump the vault generation. |
| `retrieval.classRouter` | `boolean` | `false` |  | Enable the deterministic query-class router: a temporal auto-stream and a lexical short-circuit that skips the embedding round-trip. Ships dark pending an A/B on the golden set. |
| `retrieval.colbert` | `boolean` | `false` |  | Rerank the fused top-K by bge-m3 ColBERT late-interaction maxSim. A no-op unless the provider emits the multi-vector heads. |
| `retrieval.densify.confidenceFloor` | `number` | `0.55` |  | Minimum discrete-rubric confidence required to keep an LLM-inferred edge. |
| `retrieval.densify.derivedWeight` | `number` | `0.5` |  | Down-weight factor applied to expansion reached via a derived edge. Annotates the score rather than gating the edge. |
| `retrieval.densify.includeInWalk` | `boolean` | `false` |  | Let the graph walk traverse derived edges, down-weighted against authored links. |
| `retrieval.densify.knnEdges` | `boolean` | `false` |  | Emit vec0 kNN semantic-neighbour edges (edge_type similar_to). |
| `retrieval.densify.knnK` | `number` | `8` |  | Number of neighbours per note when knnEdges is enabled. |
| `retrieval.densify.knnMinSim` | `number` | `0` |  | Drop kNN edges below this cosine similarity. 0 keeps every neighbour the kNN returns. |
| `retrieval.densify.llmEdges` | `boolean` | `false` |  | Build LLM-inferred semantic edges (semantically_similar_to) via the configured gateway. Batch-only, and it sends note content to the model — local by default. |
| `retrieval.densify.maxTagFanout` | `number` | `25` |  | A tag applied to more notes than this is treated as a hub rather than a signal and emits no edges. |
| `retrieval.densify.tagEdges` | `boolean` | `false` |  | Emit shared-frontmatter-tag co-occurrence edges (edge_type shared_tag). |
| `retrieval.gatedRerank` | `boolean` | `false` |  | Gate a cross-encoder rerank of the fused top-K onto hard queries only (weak top-1 seed, router silent). A no-op without a configured reranker (model-tier BGE or the gateway /rerank passthrough). |
| `retrieval.gatedRerankHardness.hardTop1` | `number` | `0.55` |  | Cosine mode: a query is hard when the top-1 seed cosine is below this. |
| `retrieval.gatedRerankHardness.hardZ` | `number` | `1` |  | z-margin mode: a query is hard when the top-1 z-score over the seed-cosine pool is below this. 1.0 matches the eval harness's long-standing default. |
| `retrieval.gatedRerankHardness.mode` | `enum(cosine\|zMargin)` | `"cosine"` |  | Which hardness rule gates the rerank: absolute top-1 cosine, or the model-agnostic z-margin. Default `cosine` preserves the shipped behaviour; `zMargin` is what THE-400 built and has never been the production default. |
| `retrieval.gatedRerankHardness.pool` | `number` | `20` |  | How many fused candidates the reranker sees on a hard query. |
| `retrieval.graphStream.enabled` | `boolean` | `false` |  | Enable the capped graph-expansion stream. Off by default: measured neutral on ranking quality (0 of 8 metrics significant at n=250) though non-inferior, so this is a cost lever rather than a quality one. |
| `retrieval.graphStream.expansionSeeds` | `number` | `8` |  | Expand only from the top-N seeds by score. |
| `retrieval.graphStream.hubDegreeCap` | `number` | `40` |  | Drop expansion candidates whose authored degree exceeds this, so index and dashboard pages cannot flood the fused ranking. Counts literal edges only — counting derived edges would let densification inflate every degree and suppress the bridges it exists to surface. |
| `retrieval.graphStream.perSeedCap` | `number` | `3` |  | Maximum expansion candidates any single seed may contribute. |
| `retrieval.rrfK` | `number` | `10` |  | Reciprocal-rank-fusion constant for graph_rrf. Keep BELOW the stream pool size (~30): a larger k lets overlapping low-rank noise outrank confident single-stream hits. |
| `retrieval.sparse` | `boolean` | `false` |  | Fuse a bge-m3 learned-sparse stream into RRF at serve time. A no-op unless the embeddings provider emits the multi-vector heads (bge-m3 or model-tier). |
| `retrieval.summaries.clusters.enabled` | `boolean` | `false` |  | Generate + retrieve cluster-level (tier-2/RAPTOR) summaries (THE-628, second PR). Off ships the mechanism dark: zero gateway/embed calls at the offline cluster pass, no cluster_summary candidates at retrieval time. Gated on the SAME pre-registered global-query eval as the note-level tier. |
| `retrieval.summaries.clusters.maxConcurrency` | `number` | `12` |  | In-flight extract() calls across clusters during a cluster-summary pass. Same 8-16 recommended range as the note-level tier. |
| `retrieval.summaries.enabled` | `boolean` | `false` |  | Generate + retrieve note-level summaries (THE-628). Off ships the mechanism dark: zero gateway calls at index time, no summary candidates at retrieval time. Gated on a pre-registered global-query eval, not built here. |
| `retrieval.summaries.maxConcurrency` | `number` | `12` |  | In-flight extract() calls during a summarization pass, so a large first index does not fan out one request per note unbounded. 8-16 is the recommended range (research brief). |
| `retrieval.summaries.model` | `string` | — |  | Gateway model alias override for the extract-role summarization call. Omitted -> the gateway's configured extract-role model (see gateway.models.extract). |

### `scheduler`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `scheduler.eventLoopDeferMs` | `number` | — |  | Event-loop delay p99 (ms) above which a DUE background tick is deferred rather than run. Deferred is not skipped: the tick runs on a later pass once the loop recovers, and obsidian_tc_scheduler_deferred_total counts it. Absent (the default) disables deferral entirely and the event-loop monitor is never even created, so there is no cost when off. Set it when background work is observably competing with request latency; a value near your acceptable p99 tail is the starting point. |

### `securityProfile`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `securityProfile` | `enum(hardened\|trusted-local)` | — |  | Named security posture applied before validation. 'hardened' sets the least-privilege defaults (strictReadDefault, requireCas, snapshots on, HTTP off); explicit fields override it. 'trusted-local' (the default) keeps the permissive single-user posture. |

### `sessions`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `sessions.autoOpen` | `boolean` | `false` |  | Open a workspace session automatically on a principal's first authenticated dispatch when it has none, instead of waiting for an explicit start_session. Off by default: session correlation changes what the server retains about who read what. |
| `sessions.traceContent` | `boolean` | `true` |  | Also persist each dispatch's raw parsed arguments on the session trace, secret-scanned and size-capped, so a session can be replayed with `obsidian-tc rerun`. On under the trusted-local posture; `securityProfile: "hardened"` turns it off. A trace carrying arguments holds note bodies and search queries, so it lives in cacheDir (never the vault) and is not reachable through the note surface — see THE-737. |
| `sessions.windowSeconds` | `number` | `1800` |  | How long a server-opened session keeps correlating before it becomes ELIGIBLE to be closed. This is a floor, not an exact lifetime: the closing is done by the maintenance sweep on ITS schedule (maintenance.intervalMinutes, default 60), so a session actually lives between windowSeconds and windowSeconds + that interval — with both defaults, between 30 and 90 minutes. A session is a bounded activity window, not an idle timeout: it is closed on age, never on inactivity, and the next request opens a fresh one. Explicit start_session sessions are never closed by the sweep — only end_session closes those. |

### `snapshots`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `snapshots.enabled` | `boolean` | `true` |  | Capture the prior content-addressed state before a destructive note write, so restore_note can roll back. On by default under the trusted-local posture; retention is pruned inline, so growth is bounded. |
| `snapshots.retention` | `number` | `10` |  | Maximum snapshot versions kept per note. Older versions are pruned. |

### `throttle`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `throttle.enabled` | `boolean` | `true` |  | Enforce per-scope-class rate limits. |
| `throttle.maxConcurrentWritesPerVault` | `number` | `16` |  | Ceiling on concurrent write operations against a single vault. |
| `throttle.tiers.admin.burst` | `number` | `1` |  | Bucket depth for admin-scope calls: how many may fire back-to-back before the per-minute rate applies. |
| `throttle.tiers.admin.perMinute` | `number` | `5` |  | Sustained admin-scope calls allowed per minute. |
| `throttle.tiers.bulk.burst` | `number` | `3` |  | Bucket depth for bulk-scope calls: how many may fire back-to-back before the per-minute rate applies. |
| `throttle.tiers.bulk.perMinute` | `number` | `10` |  | Sustained bulk-scope calls allowed per minute. |
| `throttle.tiers.delete.burst` | `number` | `20` |  | Bucket depth for delete-scope calls: how many may fire back-to-back before the per-minute rate applies. |
| `throttle.tiers.delete.perMinute` | `number` | `60` |  | Sustained delete-scope calls allowed per minute. |
| `throttle.tiers.execute.burst` | `number` | `1` |  | Bucket depth for execute-scope calls: how many may fire back-to-back before the per-minute rate applies. |
| `throttle.tiers.execute.perMinute` | `number` | `5` |  | Sustained execute-scope calls allowed per minute. |
| `throttle.tiers.read.burst` | `number` | `100` |  | Bucket depth for read-scope calls: how many may fire back-to-back before the per-minute rate applies. |
| `throttle.tiers.read.perMinute` | `number` | `600` |  | Sustained read-scope calls allowed per minute. |
| `throttle.tiers.write.burst` | `number` | `20` |  | Bucket depth for write-scope calls: how many may fire back-to-back before the per-minute rate applies. |
| `throttle.tiers.write.perMinute` | `number` | `60` |  | Sustained write-scope calls allowed per minute. |

### `toolFacade`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `toolFacade.mode` | `enum(triad\|domain\|flat)` | `"triad"` |  | Which surface tools/list advertises: `triad` exposes three meta-tools (find/describe/call_capability), `domain` about a dozen domain meta-tools, `flat` the full tool surface. Every registered tool stays callable by name in every mode. |

### `toolVisibility`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `toolVisibility.allowed` | `array<string>` | — |  | Name allowlist: only these tools are listed. Absent lists all; an empty array lists none. |
| `toolVisibility.disabled` | `array<string>` | `[]` |  | Tool names dropped from tools/list AND rejected at dispatch, so they behave as if unregistered. |
| `toolVisibility.disabledTags` | `array<string>` | `[]` |  | Tags whose tools are hidden and rejected at dispatch. |
| `toolVisibility.hidden` | `array<string>` | `[]` |  | Tool names dropped from tools/list but still callable by name. A leaner default surface, NOT a security boundary. |
| `toolVisibility.hiddenTags` | `array<string>` | `[]` |  | Tags whose tools are hidden from tools/list but remain callable. |
| `toolVisibility.requireReadOnly` | `boolean` | `false` |  | List only non-mutating tools. Mutation is derived from each tool's required scopes, so no per-tool annotation is needed. Hides rather than rejects. |

### `transports`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `transports.http.allowedHosts` | `array<string>` | `[]` |  | Additional Host header values accepted by the rebinding guard. |
| `transports.http.allowedOrigins` | `array<string>` | `[]` |  | Additional Origin header values accepted by the rebinding guard. |
| `transports.http.enabled` | `boolean` | `false` |  | Serve the MCP HTTP transport. |
| `transports.http.enableDnsRebindingProtection` | `boolean` | `true` |  | Reject a request whose Host is neither loopback nor operator-allowed, or whose Origin is neither same-origin nor operator-allowed. Server-to-server clients send no Origin and are unaffected. |
| `transports.http.host` | `string` | `"127.0.0.1"` |  | Bind address. A non-loopback host is refused while auth.mode is `none`, since every request would otherwise resolve to full wildcard scopes. |
| `transports.http.port` | `number` | `8765` |  | TCP port for the HTTP transport. |
| `transports.stdio` | `boolean` | `true` |  | Serve the MCP stdio transport. |

### `vaults`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `vaults` | `array<object>` | — | **yes** | Vaults this server serves. At least one is required. |
| `vaults[].acl` | `lazy` | — |  | Per-vault ACL override, same shape as the root `acl` block. Absent means the root ACL is inherited. |
| `vaults[].bridges.ocrTimeoutMs` | `number` | `30000` |  | Timeout in ms for an OCR bridge call, which is far slower than a normal request. |
| `vaults[].bridges.probeTimeoutMs` | `number` | `500` |  | Timeout in ms for the startup plugin/liveness probe. Deliberately short: it runs before the server is useful, so a dead Obsidian must not stall boot. |
| `vaults[].bridges.templaterTimeoutMs` | `number` | `30000` |  | Timeout in ms for a Templater bridge call, which may run arbitrary user template logic. |
| `vaults[].bridges.timeoutMs` | `number` | `5000` |  | Timeout in ms for a general plugin-bridge call to this vault's Local REST API. |
| `vaults[].commands.allowlist` | `array<string>` | `[]` |  | Command ids that may be fired when enabled. Only ids listed here run, and only with a HITL token — there is no wildcard. |
| `vaults[].commands.enabled` | `boolean` | `false` |  | Allow execute_command on this vault at all. Deny-by-default: command execution stays off unless this is explicitly true. |
| `vaults[].id` | `string` | — | **yes** | Stable identifier for this vault. Tools take it as their `vault` argument. |
| `vaults[].kind` | `enum(private\|docs\|system)` | `"private"` |  | Isolation kind, enforced one-directionally: the read:docs tools (knowledge_search/knowledge_get_critical) refuse any vault whose kind is not `docs`. `private` (default) = personal vault; `docs` = external docs corpus the read:docs surface is bound to; `system` = reserved internal vault. Not yet enforced: the private read:notes tools are NOT fenced out of a docs/system vault (a follow-up). |
| `vaults[].memory.folder` | `string` | `"memory"` |  | Vault folder where create_entity(materialize) writes the regenerable .md projection. A normal folder so the [[link]] graph resolves in Obsidian; SQLite remains the source of truth. |
| `vaults[].mode` | `enum(live\|headless\|auto)` | — |  | How this vault is reached. `auto` (the default when absent) probes the Local REST API once at startup: reachable means live, otherwise headless direct-filesystem access with Tier-3 action tools degrading to requires_live_obsidian. `live`/`headless` force the mode and skip the probe. |
| `vaults[].name` | `string` | — |  | Human-readable display name. Defaults to the id when absent. |
| `vaults[].path` | `string` | — | **yes** | Absolute path to the vault directory on disk. |
| `vaults[].plugins.forceDisabled` | `array<string>` | `[]` |  | Plugin ids to treat as missing regardless of what the probe finds. |
| `vaults[].plugins.forceEnabled` | `array<string>` | `[]` |  | Plugin ids to treat as installed and enabled regardless of what the probe finds. |
| `vaults[].plugins.probeSkip` | `boolean` | `false` |  | Skip the startup plugin probe entirely, making forceEnabled/forceDisabled the sole source of truth. The seam CI uses to assert tool behaviour without a live Obsidian. |
| `vaults[].restApiKey` | `string` | — |  | Bearer token for the Local REST API. Secret — never logged or echoed in a tool result. |
| `vaults[].restApiUrl` | `string` | — |  | Base URL of this vault's Obsidian Local REST API, used for live-mode bridge calls. |
| `vaults[].workspace.traceFolder` | `string` | `".obsidian-tc/traces"` |  | Vault-relative folder for append-only JSONL session traces. Defaults to a dot-folder so traces stay out of Obsidian's graph view. |

### `watch`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `watch.debounceMs` | `number` | `500` |  | Quiet period before a burst of filesystem events is flushed. One editor save emits several events and a sync pass emits one per file; this coalesces both into a single reindex per path. Raising it delays pickup, lowering it costs redundant reindex passes during a large sync. |
| `watch.enabled` | `boolean` | `true` |  | Watch each vault root and reindex notes changed outside the server (sync clients, git pull, an editor on the host). Active on ALL platforms including Windows: the watch root is resolved with realpathSync.native first, which is what the earlier Windows crash actually needed (libuv aborts when an 8.3 short path disagrees with the long-form filenames its events carry). Turn OFF for a vault on a filesystem with no usable change notification (some network mounts) or to cap inotify usage on a very large vault; index_vault then remains the only way changes are picked up. |

### `writes`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `writes.requireCas` | `boolean` | `false` |  | Require a prev_hash (compare-and-swap) on overwriting writes and on appends to an existing note, failing closed with invalid_input when absent so a stale hash cannot silently clobber. |
<!-- END GENERATED: config -->
