# Configuration

obsidian-tc reads one **JSON** config file, passed as the first CLI argument or via `OBSIDIAN_TC_CONFIG`. You can also pass a **vault folder directly for zero-config startup** (a single vault `main` with all defaults). Secrets stay off disk via environment variables.

The schema is `ServerConfigSchema`, exported from `@the-40-thieves/obsidian-tc-shared` (`packages/shared/src/config.schema.ts`). Inspect the effective config any time with `obsidian-tc config show <path>` (secrets redacted) or validate with `obsidian-tc config validate <path>`.

## Minimal config

```json
{
  "vaults": [
    { "id": "main", "path": "/Users/me/vault", "restApiKey": "<local-rest-api-key>" }
  ]
}
```

One vault, default `none` auth (loopback only), local Ollama embeddings. `restApiKey` is only needed for plugin-bridge tools — pure filesystem/search use works without it.

## Top-level fields

| Field | Type / default | Purpose |
|---|---|---|
| `cacheDir` | string, `.obsidian-tc` | Where per-vault SQLite caches, traces, and spools live |
| `vaults` | array, min 1 | Vault registry (see below) |
| `auth` | object | `none` or `jwt` (HS256 **or** asymmetric RS256/ES256/EdDSA via JWKS) |
| `acl` | object | Root access-control block; each vault may override via `vaults[].acl` |
| `embeddings` | object | Provider, model, dimensions, `chunkContext` |
| `retrieval` | `{ "rrfK": 10, "classRouter": false }` | RRF fusion constant (k=10 shipped after a measured sweep); the dark query-class router flag; and an experimental `densify` block — derived graph edges (tag co-occurrence, vec0 kNN, and an LLM pass built by the `obsidian-tc densify-llm` CLI), all **off by default** and pending measurement |
| `experiential` | object (see below) | The quarantined work-memory tier's knobs |
| `transports` | object | `stdio` (default on) and `http` (default off, loopback) |
| `governor` | `{ "maxResponseBytes": 1000000, "regexTimeoutMs": 2000 }` | Response size ceiling + regex worker-time budget (ReDoS guard) |
| `writes` | `{ "requireCas": false }` | When true, destructive note writes REQUIRE `prev_hash` (compare-and-swap) and fail closed without it |
| `snapshots` | `{ "enabled": false, "retention": 10 }` | Point-in-time snapshots of destructive writes so `restore_note` can roll back |
| `bootstrap` | `{ "domains": [], "deepPaths": [], "maxPaths": 10 }` | Session-bootstrap routing table (signals → context notes; deep-mode phrases) |
| `throttle` | object | Per-class rate tiers (read 600/100 … admin 5/1) + max concurrent writes/vault (16) |
| `observability` | object | `traceDetail` / `tracesSampleRate` / `otel` / `prometheus` / `morgiana` / `retention` |
| `toolFacade` | `{ "mode": "triad" }` | Advertised tool surface — `triad` (default) / `domain` / `flat` |
| `toolVisibility` | object (optional) | Hide/disable tools from the advertised surface |
| `plur` | object (optional) | plur read-proxy endpoint |
| `maintenance` | `{ "enabled": true, "intervalMinutes": 60 }` | Periodic `cache.db` sweep |
| `plane` | `{ "enabled": true, "intervalMinutes": 240 }` | Sleep-time consolidation scheduler; does work only with an inference gateway configured |
| `idempotencyTtlSeconds` / `idempotencyReclaimSeconds` / `elicitTtlSeconds` | `86400` / `60` / `300` | TTLs |

## The memory-engine knobs

```json
"experiential": {
  "logRetrievals": true,
  "captureEpisodes": true,
  "captureContent": false,
  "activationRerank": false
}
```

- `logRetrievals` — append serve-path retrieval events to the quarantined experiential store (local-only telemetry feeding activation recompute and citation inference).
- `captureEpisodes` — auto-capture agent tool-call outcomes as work episodes (the *action* axis).
- `captureContent` — additionally store secret-scanned call arguments (the *content* axis). **Off by default; opt in deliberately.**
- `activationRerank` — apply cached ACT-R activation in the graph rerank (dark until its A/B wins).

## Vault entry (`vaults[]`)

```json
{
  "id": "main",
  "path": "/Users/me/vault",
  "mode": "auto",
  "restApiUrl": "http://127.0.0.1:27124",
  "restApiKey": "<key from Local REST API plugin>",
  "memory": { "folder": "90-memory" },
  "workspace": { "traceFolder": ".obsidian-tc/traces" },
  "commands": { "enabled": false, "allowlist": [] },
  "bridges": { "timeoutMs": 5000, "probeTimeoutMs": 500, "ocrTimeoutMs": 30000, "templaterTimeoutMs": 30000 },
  "plugins": { "forceEnabled": ["dataview"], "probeSkip": false },
  "acl": { "readOnly": true }
}
```

`mode` is `live | headless | auto` (auto probes the Local REST API once at startup). `memory.folder` is where composite-context surfaces read/write memory notes (`_next-session.md`, reflections). `commands` is the deny-by-default command-execution gate (explicit enable + allowlist + HITL). The optional per-vault `acl` overrides the root ACL for this vault; omit it to inherit.

## Auth

HS256 (shared secret):

```json
"auth": { "mode": "jwt", "jwtSecret": "<>= 32 chars, prefer OBSIDIAN_TC_JWT_SECRET env>" }
```

Asymmetric (RS256 / ES256 / EdDSA) via a JWKS — inline `jwks` or a `jwksFile` loaded at boot; `algorithms` is an allowlist, key rotation is `kid`-based:

```json
"auth": { "mode": "jwt", "jwksFile": "/etc/obsidian-tc/jwks.json", "algorithms": ["RS256", "EdDSA"] }
```

`mode` is `none | jwt`; in `jwt` mode supply **either** `jwtSecret` **or** a JWKS. A **fail-closed interlock** refuses to start when `transports.http.enabled && auth.mode === "none"` and the host is non-loopback. Optional OAuth 2.0 Protected Resource Metadata (RFC 9728) via `auth.resource` + `auth.authorizationServers`. Full model in **[[Security and ACL]]**.

## ACL (root + per-vault)

```json
"acl": {
  "readOnly": false,
  "defaultScopes": ["read:vault"],
  "rules": [{ "glob": "02-projects/**", "scopes": ["read:vault", "write:vault"] }],
  "readPaths": ["**"],
  "writePaths": ["02-projects/**", "01-daily/**"],
  "deletePaths": [],
  "strictReadDefault": false
}
```

`readOnly: true` is the **kill switch**. `rules` are last-match-wins. Omitting `readPaths` / `writePaths` / `deletePaths` leaves that op kind unrestricted; `strictReadDefault: true` makes an undefined `readPaths` fail **closed** on reads.

## Embeddings

```json
"embeddings": {
  "provider": "ollama",
  "model": "nomic-embed-text",
  "dimensions": 768,
  "chunkContext": true
}
```

Providers: `ollama | openai | voyage | cohere | bge-m3` (the last targets a vLLM pooling server). `chunkContext` (default **true**) embeds each chunk with its note title + heading breadcrumb — measured **+0.223 nDCG**; the first reconcile after enabling re-embeds in full. Further knobs (local-runner robustness + model-specific behavior): `timeoutMs` (120000), `batchSize` (512), `maxBatchTokens` (2048 — keeps a batch inside a local runner's context), `concurrency` (4), `truncate` (false — Matryoshka/MRL truncation for wider models), `queryPrefix`/`documentPrefix` (`""` — instruct prefixes for models that require them; a document-prefix change needs a fresh `cacheDir`).

## Transports

```json
"transports": {
  "stdio": true,
  "http": { "enabled": false, "host": "127.0.0.1", "port": 8765 }
}
```

## Environment variables

| Variable | Purpose |
|---|---|
| `OBSIDIAN_TC_CONFIG` | Path to the JSON config |
| `OBSIDIAN_TC_DEFAULT_VAULT` | Default vault id when several are configured |
| `OBSIDIAN_TC_JWT_SECRET` | JWT signing secret (keeps it off disk) |
| `OBSIDIAN_TC_GATEWAY_URL` | Inference gateway base URL — enables the generative tier (see below); unset degrades gracefully |
| `OBSIDIAN_TC_GATEWAY_TOKEN` | Optional gateway bearer (e.g. a LiteLLM key); never logged |
| `OBSIDIAN_TC_PLUR_ENDPOINT` / `OBSIDIAN_TC_PLUR_TOKEN` | plur read-proxy endpoint + token |
| `OBSIDIAN_TC_FORCE_JS_FALLBACK=1` | Force the pure-JS native fallback |
| `OBSIDIAN_TC_DISABLE_FTS=1` | Disable the FTS5 index; lexical search uses the exhaustive fallback scanner (diagnostic) |
| `OBSIDIAN_TC_PROFILE=1` | Emit startup/dispatch profiling timings to stderr (diagnostic) |

## Inference gateway (generative tier)

`reflect` synthesis, `knowledge_challenge`, the sleep-time `plane`, the episode
evaluator's judge layer, and preference extraction route through one optional
OpenAI-compatible endpoint by **role** — the engine requests model names `extract`,
`synthesize`, `judge`. Wire it with the two env vars above; the recommended shape is
a self-hosted **LiteLLM container** (digest-pinned, loopback-only, zero keys for an
all-local Ollama-backed policy) whose config maps the three role aliases to real
models. Swapping a role to a hosted model is a yaml edit + container restart —
obsidian-tc never changes, and every derived note records the resolved
`provider:model`. Absence is a supported state: `reflect` degrades to recall with
`available: false` and the plane idles. Full recipe: the docs-site page
`configuration/inference-gateway.md`.

## Multi-vault

Adding or removing a vault requires a restart. `reload_vault` re-reads and **validates** the on-disk config but the server keeps its startup config until restart — config changes (including `restApiUrl`/`restApiKey` and live/headless mode, which is resolved once at boot) take effect on the next server start. Per-vault isolation (separate SQLite DBs, traces, embeddings, ACL) is detailed in **[[Architecture]]**.

## Full configuration reference (generated)

_Every key, type, default, and required flag — generated from the Zod schema. Do not hand-edit between the markers._

<!-- BEGIN GENERATED: config -->
### `acl`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `acl.defaultScopes` | `array<string>` | `[]` |  |  |
| `acl.deletePaths` | `array<string>` | — |  |  |
| `acl.readOnly` | `boolean` | `false` |  |  |
| `acl.readPaths` | `array<string>` | — |  |  |
| `acl.rules` | `array<object>` | — |  |  |
| `acl.rules[].glob` | `string` | — | **yes** |  |
| `acl.rules[].scopes` | `array<string>` | `[]` |  |  |
| `acl.strictReadDefault` | `boolean` | `false` |  |  |
| `acl.writePaths` | `array<string>` | — |  |  |

### `auth`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `auth.algorithms` | `array<string>` | — |  |  |
| `auth.audience` | `union` | — |  |  |
| `auth.authorizationServers` | `array<string>` | — |  |  |
| `auth.issuer` | `string` | — |  |  |
| `auth.jwks` | `record` | — |  |  |
| `auth.jwksFile` | `string` | — |  |  |
| `auth.jwtSecret` | `string` | — |  |  |
| `auth.mode` | `enum(none\|jwt)` | `"none"` |  |  |
| `auth.resource` | `string` | — |  |  |
| `auth.resourceName` | `string` | — |  |  |
| `auth.scopesSupported` | `array<string>` | — |  |  |
| `auth.tokenTtlSeconds` | `number` | `86400` |  |  |

### `bootstrap`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `bootstrap.deepPaths` | `array<string>` | `[]` |  |  |
| `bootstrap.deepPhrases` | `array<string>` | `["where did we leave off","what's open","whats open","catch me up","current state","where are we","what should i be working on","what should i work on"]` |  |  |
| `bootstrap.domains` | `array<object>` | — |  |  |
| `bootstrap.domains[].name` | `string` | — | **yes** |  |
| `bootstrap.domains[].paths` | `array<string>` | — | **yes** |  |
| `bootstrap.domains[].signals` | `array<string>` | — | **yes** |  |
| `bootstrap.maxPaths` | `number` | `10` |  |  |

### `cacheDir`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `cacheDir` | `string` | `".obsidian-tc"` |  |  |

### `elicitTtlSeconds`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `elicitTtlSeconds` | `number` | `300` |  |  |

### `embeddings`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `embeddings.apiKey` | `string` | — |  |  |
| `embeddings.baseUrl` | `string` | — |  |  |
| `embeddings.batchSize` | `number` | `512` |  |  |
| `embeddings.chunkContext` | `boolean` | `true` |  |  |
| `embeddings.concurrency` | `number` | `4` |  |  |
| `embeddings.dimensions` | `number` | `768` |  |  |
| `embeddings.documentPrefix` | `string` | `""` |  |  |
| `embeddings.maxBatchTokens` | `number` | `2048` |  |  |
| `embeddings.model` | `string` | `"nomic-embed-text"` |  |  |
| `embeddings.modelTier.dense.baseUrl` | `string` | — | **yes** |  |
| `embeddings.modelTier.dense.model` | `string` | `"Qwen/Qwen3-Embedding-0.6B"` |  |  |
| `embeddings.modelTier.dense.pooling` | `string` | `"last-token"` |  |  |
| `embeddings.modelTier.dense.revision` | `string` | — |  |  |
| `embeddings.modelTier.full.authToken` | `string` | — |  |  |
| `embeddings.modelTier.full.baseUrl` | `string` | — | **yes** |  |
| `embeddings.modelTier.full.dimensions` | `number` | `1024` |  |  |
| `embeddings.modelTier.full.model` | `string` | `"BAAI/bge-m3"` |  |  |
| `embeddings.modelTier.full.revision` | `string` | — |  |  |
| `embeddings.provider` | `enum(ollama\|openai\|voyage\|cohere\|bge-m3\|model-tier)` | `"ollama"` |  |  |
| `embeddings.queryPrefix` | `string` | `""` |  |  |
| `embeddings.timeoutMs` | `number` | `120000` |  |  |
| `embeddings.truncate` | `boolean` | `false` |  |  |

### `experiential`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `experiential.activationRerank` | `boolean` | `false` |  |  |
| `experiential.captureContent` | `boolean` | `false` |  |  |
| `experiential.captureEpisodes` | `boolean` | `true` |  |  |
| `experiential.logRetrievals` | `boolean` | `true` |  |  |

### `governor`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `governor.maxResponseBytes` | `number` | `1000000` |  |  |
| `governor.regexTimeoutMs` | `number` | `2000` |  |  |

### `idempotencyReclaimSeconds`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `idempotencyReclaimSeconds` | `number` | `60` |  |  |

### `idempotencyTtlSeconds`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `idempotencyTtlSeconds` | `number` | `86400` |  |  |

### `maintenance`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `maintenance.enabled` | `boolean` | `true` |  |  |
| `maintenance.intervalMinutes` | `number` | `60` |  |  |

### `observability`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `observability.morgiana.httpEndpoint` | `string` | — |  |  |
| `observability.morgiana.httpHeaders` | `record` | `{}` |  |  |
| `observability.morgiana.spool` | `boolean` | `true` |  |  |
| `observability.otel.endpoint` | `string` | — |  |  |
| `observability.otel.headers` | `record` | `{}` |  |  |
| `observability.prometheus.bind` | `string` | `"127.0.0.1"` |  |  |
| `observability.prometheus.enabled` | `boolean` | `false` |  |  |
| `observability.prometheus.port` | `number` | `9464` |  |  |
| `observability.retention.eventLogDays` | `number` | `30` |  |  |

### `plane`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `plane.enabled` | `boolean` | `true` |  |  |
| `plane.intervalMinutes` | `number` | `240` |  |  |

### `plur`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `plur.apiKey` | `string` | — |  |  |
| `plur.apiPrefix` | `string` | `""` |  |  |
| `plur.command` | `array<string>` | — |  |  |
| `plur.endpoint` | `string` | — |  |  |
| `plur.timeoutMs` | `number` | `5000` |  |  |

### `ranking`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `ranking.metadataPrior.clampFraction` | `number` | `0.5` |  |  |
| `ranking.metadataPrior.enabled` | `boolean` | `false` |  |  |
| `ranking.metadataPrior.rules` | `array<object>` | — |  |  |
| `ranking.metadataPrior.rules[].boost` | `number` | — | **yes** |  |
| `ranking.metadataPrior.rules[].field` | `string` | — | **yes** |  |
| `ranking.metadataPrior.rules[].value` | `string` | — | **yes** |  |

### `retrieval`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `retrieval.classRouter` | `boolean` | `false` |  |  |
| `retrieval.colbert` | `boolean` | `false` |  |  |
| `retrieval.densify.confidenceFloor` | `number` | `0.55` |  |  |
| `retrieval.densify.derivedWeight` | `number` | `0.5` |  |  |
| `retrieval.densify.includeInWalk` | `boolean` | `false` |  |  |
| `retrieval.densify.knnEdges` | `boolean` | `false` |  |  |
| `retrieval.densify.knnK` | `number` | `8` |  |  |
| `retrieval.densify.knnMinSim` | `number` | `0` |  |  |
| `retrieval.densify.llmEdges` | `boolean` | `false` |  |  |
| `retrieval.densify.maxTagFanout` | `number` | `25` |  |  |
| `retrieval.densify.tagEdges` | `boolean` | `false` |  |  |
| `retrieval.rrfK` | `number` | `10` |  |  |
| `retrieval.sparse` | `boolean` | `false` |  |  |

### `snapshots`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `snapshots.enabled` | `boolean` | `false` |  |  |
| `snapshots.retention` | `number` | `10` |  |  |

### `throttle`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `throttle.enabled` | `boolean` | `true` |  |  |
| `throttle.maxConcurrentWritesPerVault` | `number` | `16` |  |  |
| `throttle.tiers.admin.burst` | `number` | `1` |  |  |
| `throttle.tiers.admin.perMinute` | `number` | `5` |  |  |
| `throttle.tiers.bulk.burst` | `number` | `3` |  |  |
| `throttle.tiers.bulk.perMinute` | `number` | `10` |  |  |
| `throttle.tiers.delete.burst` | `number` | `20` |  |  |
| `throttle.tiers.delete.perMinute` | `number` | `60` |  |  |
| `throttle.tiers.execute.burst` | `number` | `1` |  |  |
| `throttle.tiers.execute.perMinute` | `number` | `5` |  |  |
| `throttle.tiers.read.burst` | `number` | `100` |  |  |
| `throttle.tiers.read.perMinute` | `number` | `600` |  |  |
| `throttle.tiers.write.burst` | `number` | `20` |  |  |
| `throttle.tiers.write.perMinute` | `number` | `60` |  |  |

### `toolFacade`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `toolFacade.mode` | `enum(triad\|domain\|flat)` | `"triad"` |  |  |

### `toolVisibility`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `toolVisibility.allowed` | `array<string>` | — |  |  |
| `toolVisibility.disabled` | `array<string>` | `[]` |  |  |
| `toolVisibility.disabledTags` | `array<string>` | `[]` |  |  |
| `toolVisibility.hidden` | `array<string>` | `[]` |  |  |
| `toolVisibility.hiddenTags` | `array<string>` | `[]` |  |  |
| `toolVisibility.requireReadOnly` | `boolean` | `false` |  |  |

### `transports`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `transports.http.allowedHosts` | `array<string>` | `[]` |  |  |
| `transports.http.allowedOrigins` | `array<string>` | `[]` |  |  |
| `transports.http.enabled` | `boolean` | `false` |  |  |
| `transports.http.enableDnsRebindingProtection` | `boolean` | `true` |  |  |
| `transports.http.host` | `string` | `"127.0.0.1"` |  |  |
| `transports.http.port` | `number` | `8765` |  |  |
| `transports.stdio` | `boolean` | `true` |  |  |

### `vaults`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `vaults` | `array<object>` | — | **yes** |  |
| `vaults[].acl` | `lazy` | — |  |  |
| `vaults[].bridges.ocrTimeoutMs` | `number` | `30000` |  |  |
| `vaults[].bridges.probeTimeoutMs` | `number` | `500` |  |  |
| `vaults[].bridges.templaterTimeoutMs` | `number` | `30000` |  |  |
| `vaults[].bridges.timeoutMs` | `number` | `5000` |  |  |
| `vaults[].commands.allowlist` | `array<string>` | `[]` |  |  |
| `vaults[].commands.enabled` | `boolean` | `false` |  |  |
| `vaults[].id` | `string` | — | **yes** |  |
| `vaults[].memory.folder` | `string` | `"memory"` |  |  |
| `vaults[].mode` | `enum(live\|headless\|auto)` | — |  |  |
| `vaults[].name` | `string` | — |  |  |
| `vaults[].path` | `string` | — | **yes** |  |
| `vaults[].plugins.forceDisabled` | `array<string>` | `[]` |  |  |
| `vaults[].plugins.forceEnabled` | `array<string>` | `[]` |  |  |
| `vaults[].plugins.probeSkip` | `boolean` | `false` |  |  |
| `vaults[].restApiKey` | `string` | — |  |  |
| `vaults[].restApiUrl` | `string` | — |  |  |
| `vaults[].workspace.traceFolder` | `string` | `".obsidian-tc/traces"` |  |  |

### `writes`

| Key | Type | Default | Required | Description |
|---|---|---|---|---|
| `writes.requireCas` | `boolean` | `false` |  |  |
<!-- END GENERATED: config -->
