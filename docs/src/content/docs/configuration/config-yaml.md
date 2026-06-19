---
title: Configuration
description: The obsidian-tc config file — vaults, auth, throttle, governor, observability, embeddings.
---

obsidian-tc reads one config file (JSON or YAML), passed as the first CLI argument
or via `OBSIDIAN_TC_CONFIG`. The full shape:

```yaml
vaults:
  - id: primary
    path: /home/user/vaults/primary
    restApiUrl: http://127.0.0.1:27123   # companion plugin (optional)
    restApiKey: ...                       # never logged
    memory: { folder: 90-memory }
    commands: { enabled: false, allowlist: [] }

cacheDir: /home/user/.cache/obsidian-tc

auth:
  mode: jwt                # none | jwt

transports:
  http:
    enabled: false
    host: 127.0.0.1
    port: 8484

governor:
  maxResponseBytes: 1048576

throttle:
  tiers:                   # rate / burst per scope class
    read:    { rate: 600, burst: 100 }
    write:   { rate: 60,  burst: 20 }
    bulk:    { rate: 10,  burst: 3 }
    execute: { rate: 5,   burst: 1 }
    admin:   { rate: 5,   burst: 1 }

observability:
  traceDetail: verbose
  tracesSampleRate: 1.0
  otel:        { endpoint: null, headers: {} }
  prometheus:  { enabled: false, bind: 127.0.0.1, port: 9464 }
  morgiana:    { spool: true, httpEndpoint: null, httpHeaders: {} }
  retention:   { morgianaEventsDays: 30, tracesDays: 7, eventLogDays: 30 }

embeddings:
  provider: none           # the deterministic fake provider drives all tests
  model: ...
```

Secrets (`restApiKey`, embedding API keys, the JWT signing key) resolve from
config-then-env and never appear in logs, error details, or audit rows.
