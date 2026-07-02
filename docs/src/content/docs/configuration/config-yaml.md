---
title: Configuration
description: The obsidian-tc config file — vaults, auth, throttle, governor, observability, embeddings.
---

obsidian-tc reads one **JSON** config file, passed as the first CLI argument or via
`OBSIDIAN_TC_CONFIG`. (You can also pass a vault folder directly for zero-config
startup.) The full shape:

```json
{
  "vaults": [
    {
      "id": "primary",
      "path": "/home/user/vaults/primary",
      "restApiUrl": "http://127.0.0.1:27123",
      "restApiKey": "...",
      "memory": { "folder": "90-memory" },
      "commands": { "enabled": false, "allowlist": [] }
    }
  ],
  "cacheDir": "/home/user/.cache/obsidian-tc",
  "toolFacade": { "mode": "triad" },
  "auth": {
    "mode": "jwt",
    "jwtSecret": "<32+ chars, or set OBSIDIAN_TC_JWT_SECRET>"
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
  }
}
```

Notes:

- **`toolFacade.mode`** — `triad` (default) | `domain` | `flat`; shapes what `tools/list` advertises (see the [Tool Reference](/tools/)).
- **`auth.mode`** — `none` | `jwt`. `jwt` requires `jwtSecret` (≥32 chars, resolvable via `OBSIDIAN_TC_JWT_SECRET`). Optional OAuth 2.0 Protected Resource Metadata (RFC 9728) is enabled by adding `auth.resource` plus one or more `auth.authorizationServers` (see [Authentication](/security/auth-model/)).
- **`embeddings.provider`** — `ollama` (default) | `openai` | `voyage` | `cohere`.

Secrets (`restApiKey`, embedding API keys, the JWT signing key) resolve from
config-then-env and never appear in logs, error details, or audit rows.
