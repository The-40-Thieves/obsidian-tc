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
| `cacheDir` | string, `.obsidian-tc` | Where the shared SQLite cache (one `cache.db` + `experiential.db`, row-scoped by vault), traces, and spools live |
| `vaults` | array, min 1 | Vault registry (see below) |
| `auth` | object | `none` or `jwt` (HS256 **or** asymmetric RS256/ES256/EdDSA via JWKS) |
| `acl` | object | Root access-control block; each vault may override via `vaults[].acl` |
| `embeddings` | object | Provider, model, dimensions, `chunkContext` |
| `retrieval` | `{ "rrfK": 10, "classRouter": false }` | RRF fusion constant (k=10 shipped after a measured sweep); the dark query-class router flag; and an experimental `densify` block — derived graph edges (tag co-occurrence, vec0 kNN, and an LLM pass built by the `obsidian-tc densify-llm` CLI), all **off by default** and pending measurement |
| `experiential` | object (see below) | The quarantined work-memory tier's knobs |
| `transports` | object | `stdio` (default on) and `http` (default off, loopback) |
| `governor` | `{ "maxResponseBytes": 1000000, "regexTimeoutMs": 2000 }` | Response size ceiling + regex worker-time budget (ReDoS guard) |
| `writes` | `{ "requireCas": false, "maxAttachmentBytes": 25000000 }` | `requireCas`: when true, destructive note writes REQUIRE `prev_hash` (compare-and-swap) and fail closed without it. `maxAttachmentBytes`: decoded-byte cap on one `write_attachment` payload |
| `snapshots` | `{ "enabled": true, "retention": 10 }` | Point-in-time snapshots of destructive writes so `restore_note` can roll back (on by default under `trusted-local`; retention is pruned inline) |
| `bootstrap` | `{ "domains": [], "deepPaths": [], "maxPaths": 10 }` | Session-bootstrap routing table (signals → context notes; deep-mode phrases) |
| `throttle` | object | Per-class rate tiers (read 600/100 … admin 5/1) + max concurrent writes/vault (16) |
| `observability` | object | `otel` / `prometheus` / `morgiana` / `retention` (`retention` bounds `event_log` rows, trace files and the morgiana spool) |
| `toolFacade` | `{ "mode": "triad" }` | Advertised tool surface — `triad` (default) / `domain` / `flat` |
| `toolVisibility` | object (optional) | Hide/disable tools from the advertised surface |
| `plur` | object (optional) | plur read-proxy endpoint |
| `maintenance` | `{ "enabled": true, "intervalMinutes": 60 }` | Periodic `cache.db` sweep |
| `plane` | `{ "enabled": false, "intervalMinutes": 240 }` | Sleep-time consolidation scheduler; **opt-in** — set `plane.enabled: true` to run it; only does work with an inference gateway configured, and a gateway-configured deployment that never sets this key gets a boot-time notice |
| `idempotencyTtlSeconds` / `idempotencyReclaimSeconds` / `elicitTtlSeconds` | `86400` / `60` / `300` | TTLs |

## The memory-engine knobs

```json
"experiential": {
  "logRetrievals": true,
  "captureEpisodes": true,
  "captureContent": true,
  "activationRerank": false
}
```

- `logRetrievals` — append serve-path retrieval events to the quarantined experiential store (local-only telemetry feeding activation recompute and citation inference).
- `captureEpisodes` — auto-capture agent tool-call outcomes as work episodes (the *action* axis).
- `captureContent` — additionally store secret-scanned call arguments (the *content* axis). **On under `trusted-local`; `securityProfile: "hardened"` turns it off**, as does setting it `false` yourself. Arguments are secret-scanned and size-capped before storage.
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

`provider` is a name resolved against the provider registry at startup, not a closed enum — an unregistered name is a startup error listing every valid option the registry currently has registered, and the registry's contents grow over time. The built-in names today: `ollama`, `openai`, `voyage`, `cohere`, `bge-m3`, the generic `openai-compatible`, `model-tier` and the profile-gated `module` (`bge-m3` targets a vLLM/TEI pooling server; `model-tier` splits dense and multi-vector retrieval across two services; `openai-compatible` serves anything OpenAI-shaped). None is privileged in code — `ollama` is only the schema default, and that default is deprecated. `chunkContext` (default **true**) embeds each chunk with its note title + heading breadcrumb — measured **+0.223 nDCG**; the first reconcile after enabling re-embeds in full. Further knobs (local-runner robustness + model-specific behavior): `timeoutMs` (120000), `batchSize` (512), `maxBatchTokens` (2048 — keeps a batch inside a local runner's context), `concurrency` (4), `truncate` (false — Matryoshka/MRL truncation for wider models), `queryPrefix`/`documentPrefix` (`""` — instruct prefixes for models that require them; a document-prefix change needs a fresh `cacheDir`).

## Transports

```json
"transports": {
  "stdio": true,
  "http": { "enabled": false, "host": "127.0.0.1", "port": 8765 }
}
```

A headless deploy with both transports on (`docker run -d`, a compose service without
`stdin_open: true`, a systemd unit) has stdin backed by `/dev/null`, which hits stdio EOF
immediately — closing only the stdio transport, not the process, as long as `http.enabled` is
true. Set `stdio: false` for a headless HTTP-only deploy to skip the notice and the stdio
transport entirely.

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
| `OBSIDIAN_TC_FORCE_READONLY_OPEN_FALLBACK=1` | **Test-only** — force the inspection-connection open (`compact --dry-run`/`--into`, `doctor`) onto its writable-descriptor fallback. Weakens the bytes-unchanged guarantee; never set it in production |
| `OBSIDIAN_TC_FORCE_READONLY_OPEN_THROW` | **Test-only** — make the NATIVE readonly open attempt fail inside the adapter (`1` at the first statement, `construct` at construction), so the fallback path runs on a platform whose native open succeeds |
| `OBSIDIAN_TC_FORCE_COMPACT_POST_OPTIMIZE_THROW=1` | **Test-only** — fail `compact` (in-place path) right after FTS5 `'optimize'` has committed its merge, so the report's partial `ftsOptimized` list is testable |
| `OBSIDIAN_TC_FORCE_COMPACT_INTO_FAILURE` | **Test-only** — interfere with `compact --into` after its `VACUUM INTO`: `1` throws, `busy` throws a `SQLITE_BUSY`, `delete:<table>` drops one row from the copy (a real row-count mismatch), `count-error:<table>` makes that table's count FAIL on the copy. Exists so the retained-copy and failed-verification paths are testable on every SQLite build |

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

<!-- END GENERATED: config -->
