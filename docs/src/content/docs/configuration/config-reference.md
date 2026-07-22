---
title: Configuration Reference
description: Every configuration key, its type, default, and whether it's required — generated from the Zod schema.
sidebar:
  order: 9
---

Every configuration key obsidian-tc understands, generated from the Zod schema so it stays in sync
with the server. For task-oriented guidance on setting these, see the
[config.yaml guide](/obsidian-tc/configuration/config-yaml/).

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
| `acl.defaultScopes` | `array<string>` | `[]` |  | Scopes granted to a path that matches no rule. |
| `acl.deletePaths` | `array<string>` | — |  | Glob whitelist for deletes: a path must match at least one entry. Omitted leaves deletes unrestricted. |
| `acl.readOnly` | `boolean` | `false` |  | Reject every mutating operation on this vault regardless of the scopes a caller holds. |
| `acl.readPaths` | `array<string>` | — |  | Glob whitelist for reads: a path must match at least one entry. Omitted leaves reads unrestricted (see strictReadDefault). |
| `acl.rules` | `array<object>` | — |  | Ordered glob-to-scope rules. Later matches override earlier ones. |
| `acl.rules[].glob` | `string` | — | **yes** | Glob matched against the vault-relative note path. |
| `acl.rules[].scopes` | `array<string>` | `[]` |  | Scopes granted to paths matching this rule. The LAST matching rule wins, replacing rather than merging the scopes of earlier matches. |
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
| `auth.jwksFile` | `string` | — |  | Path to a JWKS document, loaded once at transport boot. File or inline only — no URL fetch, so verification adds no network attack surface. |
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
| `embeddings.modelTier.dense.revision` | `string` | — |  | Pinned model revision for the dense service. |
| `embeddings.modelTier.full.authToken` | `string` | — |  | Bearer token for the multi-vector service. Secret. |
| `embeddings.modelTier.full.baseUrl` | `string` | — | **yes** | Base URL of the multi-vector (BGE-M3) service. |
| `embeddings.modelTier.full.dimensions` | `number` | `1024` |  | Dense width of the multi-vector model, separate from embeddings.dimensions. |
| `embeddings.modelTier.full.model` | `string` | `"BAAI/bge-m3"` |  | Multi-vector model id. |
| `embeddings.modelTier.full.revision` | `string` | — |  | Pinned model revision for the multi-vector service. |
| `embeddings.provider` | `enum(ollama\|openai\|voyage\|cohere\|bge-m3\|model-tier)` | `"ollama"` |  | Embeddings backend. `model-tier` splits dense and multi-vector across two services. |
| `embeddings.queryPrefix` | `string` | `""` |  | Instruct prefix prepended to query-side embeds, for models whose cards require one. Empty by default — such prefixes measured harmful on this corpus. |
| `embeddings.timeoutMs` | `number` | `120000` |  | Timeout in ms for a single embed request. Defaults high because local runners are far slower than hosted APIs. |
| `embeddings.truncate` | `boolean` | `false` |  | Matryoshka (MRL) truncation: accept a provider vector WIDER than `dimensions` by keeping the first `dimensions` components and renormalising. Off by default so a non-MRL width mismatch errors instead of silently storing a meaningless prefix. |

### `experiential`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `experiential.activationRerank` | `boolean` | `false` |  | Apply the ACT-R activation bubble pass (bounded adjacent swaps) to serve-path vault_graph_search using cached activation scores. Ships dark pending an A/B on the golden set. |
| `experiential.captureContent` | `boolean` | `false` |  | Also persist each episode's raw parsed arguments, secret-scanned and size-capped. Off until the poisoning defence lands: this is the write-side of the gate. |
| `experiential.captureEpisodes` | `boolean` | `true` |  | Record every dispatch outcome as an agent_episodes row — tool, status, duration, sizes, hashes, attribution. No payloads are stored. |
| `experiential.logRetrievals` | `boolean` | `true` |  | Append serve-path retrieval events (chunk id, rank, score, query text, surface) to experiential.db. Local-only telemetry feeding activation recompute and usage stats; eval runs never log. |

### `governor`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `governor.maxResponseBytes` | `number` | `1000000` |  | Ceiling on a single tool response in bytes, before it is truncated or refused. |
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
| `indexing.queueMax` | `number` | `1000` |  | Soft cap on distinct pending paths, surfaced as backpressure in server_health. Writes are never dropped when it is exceeded. |
| `indexing.writeConcurrency` | `number` | `8` |  | Ceiling on concurrent index/embed calls across ALL vaults. |
| `indexing.writeConcurrencyPerVault` | `number` | `4` |  | Ceiling on concurrent index/embed calls for a single vault. |

### `maintenance`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `maintenance.enabled` | `boolean` | `true` |  | Run the periodic cache.db maintenance sweep (expired idempotency and elicitation rows, event_log retention, PRAGMA optimize). |
| `maintenance.intervalMinutes` | `number` | `60` |  | Minutes between maintenance sweeps. |

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
| `observability.retention.eventLogDays` | `number` | `30` |  | Days of event_log rows kept by the maintenance sweep. This is the ONLY retention that is enforced: trace files and the event spool are not pruned and grow without bound. |

### `plane`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `plane.enabled` | `boolean` | `true` |  | Run ambient sleep-time consolidation (synthesis and audit jobs). Only meaningful when the inference gateway roles are configured. |
| `plane.intervalMinutes` | `number` | `240` |  | Minutes between consolidation passes. |

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

### `retrieval`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
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
| `retrieval.rrfK` | `number` | `10` |  | Reciprocal-rank-fusion constant for graph_rrf. Keep BELOW the stream pool size (~30): a larger k lets overlapping low-rank noise outrank confident single-stream hits. |
| `retrieval.sparse` | `boolean` | `false` |  | Fuse a bge-m3 learned-sparse stream into RRF at serve time. A no-op unless the embeddings provider emits the multi-vector heads (bge-m3 or model-tier). |

### `snapshots`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `snapshots.enabled` | `boolean` | `false` |  | Capture the prior content-addressed state before a destructive note write, so restore_note can roll back. |
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

### `writes`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `writes.requireCas` | `boolean` | `false` |  | Require a prev_hash (compare-and-swap) on overwriting writes and on appends to an existing note, failing closed with invalid_input when absent so a stale hash cannot silently clobber. |
<!-- END GENERATED: config -->
