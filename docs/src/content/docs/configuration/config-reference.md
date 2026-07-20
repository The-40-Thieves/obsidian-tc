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
