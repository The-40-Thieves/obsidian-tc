---
title: Configuration reference
description: Every obsidian-tc option — the complete config schema, all defaults, environment variables, and the CLI.
---

obsidian-tc reads one **JSON** config file, passed as the first CLI argument or via
`OBSIDIAN_TC_CONFIG`. Zero-config also works: pass a **vault folder** instead and the
server boots a single vault with id `main` and every default below. Inspect any
config with `obsidian-tc config show <path>` (secrets redacted) or
`obsidian-tc config validate <path>`.

This page is the **complete option surface**, derived from `ServerConfigSchema`
(`packages/shared/src/config.schema.ts`) — every field, with its default. Fields
marked *(optional)* may be omitted entirely; every other block is fully defaulted,
so any subset of this document is a valid config.

## The full shape (all defaults shown)

```json
{
  "cacheDir": ".obsidian-tc",
  "vaults": [
    {
      "id": "main",
      "name": "My Vault",
      "path": "/absolute/path/to/vault",
      "mode": "auto",
      "restApiUrl": "http://127.0.0.1:27123",
      "restApiKey": "<Local REST API key>",
      "acl": { "readOnly": false },
      "bridges": { "timeoutMs": 5000, "probeTimeoutMs": 500, "ocrTimeoutMs": 30000, "templaterTimeoutMs": 30000 },
      "plugins": { "forceEnabled": [], "forceDisabled": [], "probeSkip": false },
      "commands": { "enabled": false, "allowlist": [] },
      "memory": { "folder": "memory" },
      "workspace": { "traceFolder": ".obsidian-tc/traces" }
    }
  ],
  "auth": { "mode": "none", "tokenTtlSeconds": 86400 },
  "acl": {
    "readOnly": false,
    "defaultScopes": [],
    "rules": [],
    "readPaths": ["**"],
    "writePaths": ["02-projects/**"],
    "deletePaths": [],
    "strictReadDefault": false
  },
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "dimensions": 768,
    "timeoutMs": 120000,
    "batchSize": 512,
    "maxBatchTokens": 2048,
    "concurrency": 4,
    "truncate": false,
    "chunkContext": true,
    "queryPrefix": "",
    "documentPrefix": ""
  },
  "retrieval": {
    "rrfK": 10,
    "classRouter": false,
    "sparse": false,
    "colbert": false,
    "densify": {
      "tagEdges": false,
      "maxTagFanout": 25,
      "knnEdges": false,
      "knnK": 8,
      "includeInWalk": false,
      "derivedWeight": 0.5,
      "llmEdges": false,
      "confidenceFloor": 0.55
    }
  },
  "experiential": {
    "logRetrievals": true,
    "captureEpisodes": true,
    "captureContent": false,
    "activationRerank": false
  },
  "transports": {
    "stdio": true,
    "http": {
      "enabled": false,
      "host": "127.0.0.1",
      "port": 8765,
      "enableDnsRebindingProtection": true,
      "allowedHosts": [],
      "allowedOrigins": []
    }
  },
  "governor": { "maxResponseBytes": 1000000, "regexTimeoutMs": 2000 },
  "writes": { "requireCas": false },
  "toolFacade": { "mode": "triad" },
  "toolVisibility": { "hidden": [], "disabled": [], "hiddenTags": [], "disabledTags": [], "requireReadOnly": false },
  "bootstrap": { "deepPaths": [], "domains": [], "maxPaths": 10 },
  "throttle": {
    "enabled": true,
    "maxConcurrentWritesPerVault": 16,
    "tiers": {
      "read":    { "perMinute": 600, "burst": 100 },
      "write":   { "perMinute": 60,  "burst": 20 },
      "delete":  { "perMinute": 60,  "burst": 20 },
      "bulk":    { "perMinute": 10,  "burst": 3 },
      "execute": { "perMinute": 5,   "burst": 1 },
      "admin":   { "perMinute": 5,   "burst": 1 }
    }
  },
  "observability": {
    "traceDetail": "standard",
    "tracesSampleRate": 1.0,
    "otel":       { "headers": {} },
    "prometheus": { "enabled": false, "bind": "127.0.0.1", "port": 9464 },
    "morgiana":   { "spool": true, "httpHeaders": {} },
    "retention":  { "morgianaEventsDays": 90, "tracesDays": 90, "eventLogDays": 30 }
  },
  "maintenance": { "enabled": true, "intervalMinutes": 60 },
  "snapshots": { "enabled": false, "retention": 10 },
  "plane": { "enabled": true, "intervalMinutes": 240 },
  "idempotencyTtlSeconds": 86400,
  "idempotencyReclaimSeconds": 60,
  "elicitTtlSeconds": 300
}
```

## Vault entries (`vaults[]`, min 1)

| Field | Type / default | What it does |
| --- | --- | --- |
| `id` | string, required | Vault identifier every tool call names (`vault: "main"`). Lowercase `[a-z0-9_-]`. |
| `name` | string *(optional)* | Display name. |
| `path` | string, required | Absolute vault directory. |
| `mode` | `live \| headless \| auto` *(optional → auto)* | `auto` probes the Local REST API **once at startup**: reachable → live (bridge tools work), else headless (bridge tools return `requires_live_obsidian`; filesystem tools unaffected). Resolved once — config changes take effect on the next server start. |
| `restApiUrl` | url *(optional)* | Local REST API base for live mode. Use the plugin's **non-encrypted loopback server** (`http://127.0.0.1:27123`, enable it in LRA settings) — the bridge client does not trust LRA's self-signed HTTPS certificate. Without this the vault is always headless. |
| `restApiKey` | string *(optional)* | The LRA API key. Treat as a full-vault admin credential. |
| `acl` | object *(optional)* | Per-vault ACL override, same shape as the root `acl` — "write vault A, read-only vault B" in one process. |
| `bridges.timeoutMs` | int, 5000 | Per-route bridge timeout. |
| `bridges.probeTimeoutMs` | int, 500 | Startup capability-probe timeout. |
| `bridges.ocrTimeoutMs` | int, 30000 | OCR route timeout. |
| `bridges.templaterTimeoutMs` | int, 30000 | Templater/execute route timeout. |
| `plugins.forceEnabled` | string[], `[]` | Treat these plugin ids as installed regardless of the probe (CI seam with `probeSkip`). |
| `plugins.forceDisabled` | string[], `[]` | Treat as missing — exercises `plugin_missing` or operationally disables a bridge. |
| `plugins.probeSkip` | bool, false | Skip the startup probe entirely; `forceEnabled` becomes the source of truth. |
| `commands.enabled` | bool, **false** | Deny-by-default gate for `execute_command`. |
| `commands.allowlist` | string[], `[]` | Command ids that may fire (still HITL-gated). Arbitrary command execution is never silent. |
| `memory.folder` | string, `"memory"` | Where memory-entity projections, `_next-session.md`, and `reflections/` live. |
| `workspace.traceFolder` | string, `".obsidian-tc/traces"` | Vault-relative JSONL session-trace folder (ACL-checked). |

## `auth`

| Field | Type / default | What it does |
| --- | --- | --- |
| `mode` | `none \| jwt`, `none` | `none` is loopback-only (see the interlock below). |
| `jwtSecret` | string ≥32 *(optional)* | HS256 shared secret; prefer `OBSIDIAN_TC_JWT_SECRET`. |
| `tokenTtlSeconds` | int, 86400 | Token lifetime. |
| `jwks` / `jwksFile` | object / path *(optional)* | Asymmetric verification (RS256/ES256/EdDSA) from an inline JWKS or a file loaded once at boot — never a URL fetch. Rotation is `kid`-based. HS256 verifies only against the secret and asymmetric algs only against the JWKS, so alg-confusion is structurally impossible. |
| `algorithms` | string[] *(optional)* | Asymmetric-algorithm allowlist. |
| `resource`, `authorizationServers`, `resourceName`, `scopesSupported` | *(optional)* | RFC 9728 Protected Resource Metadata: when `resource` + one `authorizationServers` entry are set, the HTTP transport advertises a PRM document + `WWW-Authenticate` challenge (OAuth 2.1 resource-server role). |

`mode: "jwt"` requires `jwtSecret` **or** a JWKS — the config refuses to load otherwise.

**Fail-closed interlock:** the config is rejected when `transports.http.enabled` is
true on a **non-loopback** host while `auth.mode` is `none`. An unauthenticated
server never binds a routable address.

## `acl` (root, inherited by every vault without its own)

| Field | Type / default | What it does |
| --- | --- | --- |
| `readOnly` | bool, false | The kill switch — every write/delete short-circuits to `read_only_mode`. |
| `defaultScopes` | string[], `[]` | Scopes granted when the caller presents none. |
| `rules` | `[{glob, scopes}]`, `[]` | Path-scoped scope grants; last match wins. |
| `readPaths` / `writePaths` / `deletePaths` | glob[] *(optional)* | Per-operation whitelists. Omitted = that operation unrestricted; present = a path must match at least one glob. `.obsidian/`, `.git/`, `.trash/` are always denied (case-folded, so case variants can't evade it). |
| `strictReadDefault` | bool, false | When true, an **undefined** `readPaths` fails closed on reads instead of allowing all. |

## `embeddings`

| Field | Type / default | What it does |
| --- | --- | --- |
| `provider` | `ollama \| openai \| voyage \| cohere \| bge-m3`, `ollama` | `bge-m3` targets a vLLM pooling server (dense + learned-sparse + ColBERT heads). |
| `model` | string, `nomic-embed-text` | |
| `dimensions` | int, 768 | The vec0 table is dimension-locked; changing it requires a fresh `cacheDir` (see [migration](/configuration/embedding-model-migration/)). |
| `baseUrl` | url *(optional)* | Provider endpoint (e.g. `http://127.0.0.1:11434` for Ollama). |
| `apiKey` | string *(optional)* | Cloud-provider key; config-then-env, never logged. |
| `timeoutMs` | int, 120000 | Per embed request. |
| `batchSize` | int, 512 | Max inputs per request. |
| `maxBatchTokens` | int, 2048 | Estimated-token cap per request (chars/4) — keeps a dense batch inside a local runner's context (Ollama defaults to n_ctx 4096 and 400-rejects overruns; the indexer bisects and retries anyway). |
| `concurrency` | int, 4 | Embed requests in flight. |
| `truncate` | bool, false | Matryoshka (MRL) truncation: a provider returning vectors **wider** than `dimensions` is truncated + renormalized. Non-MRL width mismatches still error. |
| `chunkContext` | bool, **true** | Contextual enrichment: each chunk embeds + BM25-indexes as `"{title} — {breadcrumb}\n\n{content}"`. Measured **+0.223 nDCG@10 (p=0.0001)**. The content hash covers the enriched text, so flipping it re-embeds on the next reconcile. |
| `queryPrefix` / `documentPrefix` | string, `""` | Asymmetric instruct prefixes for models that require them (e.g. Qwen3-Embedding's query instruction). Changing `documentPrefix` does not re-embed by itself — pair it with a fresh `cacheDir`. |

## `retrieval` and `experiential`

| Field | Default | What it does |
| --- | --- | --- |
| `retrieval.rrfK` | 10 | RRF fusion constant. Keep below the stream pool size (~30): k=10 beat k=60 on every metric — larger k lets overlapping low-rank noise outrank confident single-stream hits. |
| `retrieval.classRouter` | false | The deterministic query-class router (temporal auto-stream + lexical short-circuit). **Dark by measurement** — flips only if its A/B passes the ship rule. |
| `retrieval.sparse` | false | Serve-path bge-m3 learned-sparse RRF stream (needs a multi-vector `embedFull` provider). **Dark** — a no-op without one, measured on the golden set before any flip. |
| `retrieval.colbert` | false | Serve-path bge-m3 ColBERT late-interaction rerank of the fused top-K (needs a multi-vector provider). **Dark** — measured before any flip. |
| `experiential.logRetrievals` | true | Append serve-path retrieval events to the quarantined `experiential.db` (local-only telemetry feeding activation recompute + flywheel stats; eval runs never log). |
| `experiential.captureEpisodes` | true | Capture every dispatch outcome as a work-memory episode (action axis: tool, status, sizes, hashes — no payloads). |
| `experiential.captureContent` | **false** | Content axis: also persist secret-scanned, size-capped call args. Off by default — opt in deliberately. |
| `experiential.activationRerank` | false | ACT-R activation rerank pass on serve-path graph search. **Dark** pending its A/B. |

### `retrieval.densify` — graph densification (experimental)

Derived edges added to the `vault_edges` graph beyond authored wikilinks, so a multi-hop query can reach bridge notes that were never explicitly linked. **All off/conservative by default and unmeasured** — the prior THE-135 virtual-hop sat at an 80% bridge-recall ceiling *below* the current champion (bridge recall 0.831), so densification ships dark behind these flags pending a multi-hop golden-set A/B, exactly like `retrieval.sparse` / `retrieval.colbert`. Derived edges are rebuildable cache and are **never** written back into notes as wikilinks; hub tags and hub nodes emit no edges.

| Field | Default | What it does |
| --- | --- | --- |
| `tagEdges` | false | Emit `shared_tag` edges between notes sharing a frontmatter tag (deterministic, no egress). Built during `index_vault`. |
| `maxTagFanout` | 25 | A tag on more than this many notes is a hub, not a signal — it emits no edges. |
| `knnEdges` | false | Emit `similar_to` edges from vec0 kNN semantic neighbours (no egress; needs a populated vector index). Built during `index_vault`. |
| `knnK` | 8 | Neighbours kept per note for `knnEdges`. |
| `includeInWalk` | false | Let the graph walk traverse derived edges, down-weighted vs authored links (annotate, never outrank an authored link at equal hop). |
| `derivedWeight` | 0.5 | Expansion down-weight applied when a hop is reached via a derived edge. |
| `llmEdges` | false | Build `semantically_similar_to` edges via LLM Pass-3 through the **local** inference gateway. Batch-only via the `densify-llm` CLI — not the inline index pass; sends note content to the model (local by default). |
| `confidenceFloor` | 0.55 | Minimum discrete-rubric confidence (0.55/0.65/0.75/0.85/0.95) to keep an LLM edge. |

`llmEdges` is produced out-of-band by `obsidian-tc densify-llm` (below), not by indexing; `tagEdges` and `knnEdges` build inline during `index_vault` when set.

## `transports`

| Field | Default | What it does |
| --- | --- | --- |
| `stdio` | true | The trusted local transport. |
| `http.enabled` | false | Streamable HTTP for many-client / remote use. |
| `http.host` / `http.port` | `127.0.0.1` / 8765 | Non-loopback hosts require JWT (interlock above). |
| `http.enableDnsRebindingProtection` | true | Rejects requests whose Host isn't loopback/allowed, or whose Origin isn't same-origin/allowed. Server-to-server clients (no Origin) are unaffected. |
| `http.allowedHosts` / `http.allowedOrigins` | `[]` | Operator allowlists for the above. |

## Governance, safety, and surface shaping

| Field | Default | What it does |
| --- | --- | --- |
| `governor.maxResponseBytes` | 1000000 | Response size ceiling — page with cursors rather than raising it. |
| `governor.regexTimeoutMs` | 2000 | Worker-time budget for one regex search (ReDoS guard; file I/O doesn't count). |
| `writes.requireCas` | false | When true, `write_note` (overwrite) and `append_note` to an existing note **require** `prev_hash` and fail closed without it — no stale-hash clobbering. |
| `snapshots.enabled` | false | Point-in-time snapshots: destructive writes capture prior state (content-addressed) so `restore_note` can roll back. |
| `snapshots.retention` | 10 | Versions kept per note (max 1000). |
| `toolFacade.mode` | `triad` | What `tools/list` advertises: `triad` (3 meta-tools), `domain` (~a dozen domain meta-tools), `flat` (everything). All tools stay callable by name in every mode. |
| `toolVisibility.allowed` | *(optional)* | Name allowlist for `tools/list` (absent = all; `[]` = none). |
| `toolVisibility.hidden` / `hiddenTags` | `[]` | Drop from `tools/list` but keep callable (lean surface, not a security boundary). |
| `toolVisibility.disabled` / `disabledTags` | `[]` | Drop from the list **and** reject at dispatch. |
| `toolVisibility.requireReadOnly` | false | Hide every mutating tool (derived from scopes — no per-tool annotation needed). |
| `idempotencyTtlSeconds` | 86400 | Idempotency-key replay window. |
| `idempotencyReclaimSeconds` | 60 | Window before a crashed in-flight idempotency row may be reclaimed — raise for slow bulk tools. |
| `elicitTtlSeconds` | 300 | HITL elicit-token lifetime (single-use, args-hash-bound). |

## `bootstrap` (session-bootstrap routing)

Powers `session_bootstrap`: triages a session's opening message to
lightweight / standard / deep and preloads the matching context notes. The routing
table is a judgment value **you** supply — it never ships baked in.

| Field | Default | What it does |
| --- | --- | --- |
| `domains` | `[]` | `[{name, signals[], paths[]}]` — a domain matches when any lowercased signal is a substring of the opening message; its `paths` load. |
| `deepPaths` | `[]` | Notes loaded in deep mode. |
| `deepPhrases` | catch-up phrases ("where did we leave off", "catch me up", …) | A hit forces deep mode. |
| `maxPaths` | 10 | Cap on loaded notes (max 50). |

## `throttle`

Per-scope-class token buckets: `read` 600/min (burst 100), `write` 60/20, `delete`
60/20, `bulk` 10/3, `execute` 5/1, `admin` 5/1 — each `{perMinute, burst}` —
plus `maxConcurrentWritesPerVault` (16) and a master `enabled` (true). A trip
returns `rate_limit` with `retry_after_ms`.

## `observability`

| Field | Default | What it does |
| --- | --- | --- |
| `traceDetail` | `standard` | `verbose` adds per-layer detail to spans/traces. |
| `tracesSampleRate` | 1.0 | 0–1. |
| `otel.endpoint` | *(optional)* | OTLP export; unset = no-op. `otel.headers` for auth. |
| `prometheus` | disabled, `127.0.0.1:9464` | `/metrics` scrape endpoint. |
| `morgiana.spool` | true | CloudEvents JSONL spool; `httpEndpoint` (+`httpHeaders`) enables push. |
| `retention` | 90/90/30 days | morgiana events / traces / event_log. |

## Background schedulers

| Field | Default | What it does |
| --- | --- | --- |
| `maintenance` | enabled, every 60 min | `cache.db` sweep: expired idempotency/elicit rows, event_log retention, `PRAGMA optimize`. |
| `plane` | enabled, every 240 min | Ambient sleep-time consolidation (synthesis + audit jobs). Only does work when the [inference gateway](/configuration/inference-gateway/) is configured. |

## `plur` *(optional)*

Global (not per-vault) read-proxy for a [plur](https://github.com/plur-ai) engram
store: `endpoint` + `apiKey` (or the env vars below) for HTTP, **or** `command`
(argv prefix, e.g. `["plur"]`) to shell the local plur CLI — `command` takes
precedence. `apiPrefix` (`""`), `timeoutMs` (5000). Absent endpoint/command → the
plur tools degrade to `plugin_missing` with no network call.

## Environment variables (complete)

| Variable | Purpose |
| --- | --- |
| `OBSIDIAN_TC_CONFIG` | Config path when no CLI argument is given. |
| `OBSIDIAN_TC_DEFAULT_VAULT` | Default vault id when several are configured. |
| `OBSIDIAN_TC_JWT_SECRET` | HS256 signing secret (keeps it off disk). |
| `OBSIDIAN_TC_GATEWAY_URL` | Inference-gateway base URL — enables the generative tier ([setup](/configuration/inference-gateway/)). |
| `OBSIDIAN_TC_GATEWAY_TOKEN` | Optional gateway bearer (e.g. a LiteLLM key). Never logged. |
| `OBSIDIAN_TC_PLUR_ENDPOINT` / `OBSIDIAN_TC_PLUR_TOKEN` | plur read-proxy endpoint + bearer. |
| `OBSIDIAN_TC_FORCE_JS_FALLBACK=1` | Skip the native module; use the numerically identical pure-JS implementations. |
| `OBSIDIAN_TC_DISABLE_FTS=1` | Disable the FTS5 index; lexical search uses the exhaustive fallback scanner (diagnostic). |
| `OBSIDIAN_TC_PROFILE=1` | Emit startup/dispatch profiling timings to stderr (diagnostic). |

Secrets (`restApiKey`, embedding API keys, the JWT secret, gateway/plur tokens)
resolve config-then-env and never appear in logs, error details, or audit rows.

## Applying config changes

Config is read **at server start**; live/headless mode is also resolved once at
start. `reload_vault` re-validates the on-disk file but the server keeps its
startup config — restart the server (or your MCP client) to apply changes. Adding
or removing a vault always requires a restart; destructive changes (`path`,
embeddings provider/model/dimensions, `cacheDir`) additionally need
`reset_vault_cache` or a fresh `cacheDir`.

## See also

- [Inference gateway setup](/configuration/inference-gateway/) — the generative tier.
- [Embedding model migration](/configuration/embedding-model-migration/) — changing models safely.
- The CLI: `obsidian-tc help` lists the full offline command family (`serve`, `config show|validate`, `plugin install`, `cluster`, `activation-recompute`, `prefetch`, `reflect`, `metrics`, `gaps`, `forget`, `version`); each command takes the same config path.
