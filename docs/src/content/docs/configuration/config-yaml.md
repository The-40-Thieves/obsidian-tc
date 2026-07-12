---
title: Configuration
description: The obsidian-tc config file — vaults, auth, throttle, governor, observability, embeddings.
---

obsidian-tc reads one **JSON** config file, passed as the first CLI argument or via
`OBSIDIAN_TC_CONFIG`. (You can also pass a vault folder directly for zero-config
startup.) The full shape:

Retrieval and memory-engine knobs (all defaults shown below): `retrieval.rrfK` is
the RRF fusion constant (k=10 shipped after a measured sweep); `retrieval.classRouter`
enables the dark query-class router (off — its lexical short-circuit lost its A/B).
Under `experiential`: `logRetrievals` appends serve-path retrieval events to the
quarantined experiential store (local-only telemetry feeding activation recompute and
citation inference); `captureEpisodes` auto-captures agent tool-call outcomes as work
episodes (the action axis); `captureContent` additionally stores secret-scanned call
arguments (the content axis — **off by default**, opt in deliberately);
`activationRerank` applies cached ACT-R activation in the graph rerank (dark until its
A/B wins). `embeddings.chunkContext` (default **true**) embeds each chunk with its
note title + heading breadcrumb — measured +0.223 nDCG; the first reconcile after
enabling re-embeds in full.

```json
{
  "vaults": [
    {
      "id": "primary",
      "path": "/home/user/vaults/primary",
      "mode": "auto",
      "restApiUrl": "http://127.0.0.1:27123",
      "restApiKey": "...",
      "memory": { "folder": "90-memory" },
      "workspace": { "traceFolder": ".obsidian-tc/traces" },
      "commands": { "enabled": false, "allowlist": [] },
      "bridges": { "timeoutMs": 5000, "probeTimeoutMs": 500, "ocrTimeoutMs": 30000, "templaterTimeoutMs": 30000 },
      "plugins": { "forceEnabled": [], "forceDisabled": [], "probeSkip": false },
      "acl": { "readOnly": false, "writePaths": ["02-projects/**"] }
    }
  ],
  "cacheDir": "/home/user/.cache/obsidian-tc",
  "toolFacade": { "mode": "triad" },
  "retrieval": { "rrfK": 10, "classRouter": false },
  "experiential": {
    "logRetrievals": true,
    "captureEpisodes": true,
    "captureContent": false,
    "activationRerank": false
  },
  "toolVisibility": { "hidden": [], "disabled": [], "requireReadOnly": false },
  "auth": {
    "mode": "jwt",
    "jwtSecret": "<32+ chars, or set OBSIDIAN_TC_JWT_SECRET>"
  },
  "acl": {
    "readOnly": false,
    "defaultScopes": [],
    "rules": [],
    "readPaths": ["**"],
    "writePaths": ["02-projects/**", "90-memory/**"],
    "deletePaths": ["02-projects/**"],
    "strictReadDefault": false
  },
  "transports": {
    "http": { "enabled": false, "host": "127.0.0.1", "port": 8765 }
  },
  "governor": { "maxResponseBytes": 1048576 },
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
    "traceDetail": "verbose",
    "tracesSampleRate": 1.0,
    "otel":       { "endpoint": null, "headers": {} },
    "prometheus": { "enabled": false, "bind": "127.0.0.1", "port": 9464 },
    "morgiana":   { "spool": true, "httpEndpoint": null, "httpHeaders": {} },
    "retention":  { "morgianaEventsDays": 90, "tracesDays": 90, "eventLogDays": 30 }
  },
  "embeddings": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "dimensions": 768
  },
  "maintenance": { "enabled": true, "intervalMinutes": 60 },
  "plane": { "enabled": true, "intervalMinutes": 240 },
  "idempotencyTtlSeconds": 86400,
  "idempotencyReclaimSeconds": 60,
  "elicitTtlSeconds": 300
}
```

Notes:

- **`toolFacade.mode`** — `triad` (default) | `domain` | `flat`; shapes what `tools/list` advertises (see the [Tool Reference](/tools/)).
- **`auth.mode`** — `none` | `jwt`. `jwt` requires `jwtSecret` (≥32 chars, resolvable via `OBSIDIAN_TC_JWT_SECRET`). Optional OAuth 2.0 Protected Resource Metadata (RFC 9728) is enabled by adding `auth.resource` plus one or more `auth.authorizationServers` (see [Authentication](/security/auth-model/)).
- **`embeddings.provider`** — `ollama` (default) | `openai` | `voyage` | `cohere`.
- **`acl`** — the root folder ACL (default for every vault); each `vaults[]` entry may carry its own `acl` to override it (see [Scopes & Folder ACLs](/security/acls/)).
- **`auth.jwks` / `auth.jwksFile` / `auth.algorithms`** — asymmetric JWT verification (RS256/ES256/EdDSA) with `kid` rotation; a JWKS may stand in for `jwtSecret` (see [Authentication](/security/auth-model/)).
- **`plane`** — ambient consolidation scheduler (`enabled` default `true`, `intervalMinutes` `240`); does work only when the inference gateway is configured.
- **`maintenance`** — periodic `cache.db` sweep (`enabled` default `true`, `intervalMinutes` `60`).
- **TTLs** — `idempotencyTtlSeconds` (`86400`), `idempotencyReclaimSeconds` (`60`), `elicitTtlSeconds` (`300`).
- **Per-vault** — `mode` (`live` | `headless` | `auto`), `workspace.traceFolder`, `bridges` (probe / OCR / Templater timeouts), `plugins` (force enable/disable, probe skip), and an optional per-vault `acl`.
- **`toolVisibility`** (optional) — trims the advertised tool surface (`hidden` / `disabled` / `hiddenTags` / `disabledTags` / `requireReadOnly` / `allowed`); tools stay callable by name unless `disabled`.
- **Live mode (plugin bridges)** — bridge tools need `vaults[].restApiUrl` **and**
  `restApiKey`; without them the vault resolves **headless** and every bridge tool
  returns the typed `requires_live_obsidian`. Use Local REST API's **non-encrypted
  loopback server** (`http://127.0.0.1:27123`, enable it in the LRA settings) — the
  bridge client does not trust LRA's self-signed HTTPS certificate. Mode is resolved
  **once at startup** by probing `restApiUrl`; `reload_vault` re-validates the on-disk
  config but the server keeps its startup config until restart, so config changes
  (including these keys) take effect on the next server start.

Secrets (`restApiKey`, embedding API keys, the JWT signing key) resolve from
config-then-env and never appear in logs, error details, or audit rows.
