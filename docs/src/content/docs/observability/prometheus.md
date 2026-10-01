---
title: Prometheus Metrics
description: The metrics catalog and the optional, auth-gated /metrics scrape endpoint.
---

<!-- BEGIN GENERATED: metrics-catalog -->

<!-- END GENERATED: metrics-catalog -->

Labels are deliberately **low-cardinality** — `vault` and `scope_class`, never raw
tool arguments or per-caller hashes — so the series count stays bounded.

## The /metrics endpoint

Disabled by default. When `observability.prometheus.enabled` is set, a small HTTP
listener serves `/metrics` on `prometheus.bind:port`. Its auth floor mirrors the
MCP HTTP transport:

- **loopback bind** → open, no token needed;
- **non-loopback bind** → requires a verified JWT that holds the **`admin:metrics`** scope and is
  not bound to a vault or persona;
- **non-loopback + `auth.mode: none`** → refused at startup.

On a non-loopback bind the responses are:

| request | status |
|---|---|
| no bearer, or a bearer that fails verification | `401` |
| verified, but no `admin:metrics` grant | `403`, `WWW-Authenticate: Bearer error="insufficient_scope", scope="admin:metrics"` |
| verified with the scope, but bound to a vault (`vault` claim) or a persona | `403` |
| verified, scope held, unbound | `200` |

`admin:metrics` is the scope the `get_metrics` tool already requires, and it is matched the same
way: `*`, `admin:*` and `admin` grant it; `read:*` and other `admin:` scopes do not. Under
`auth.mode: oidc` the scope has to come out of your `claimMapping` / `scopeMap` like any other.

Every series on this endpoint is process-wide and is computed without a per-caller ACL (queue
depths, call counts and ACL-denial counts for every vault), so the scope is the authorization and
there is no per-vault filtering: a token bound to one vault is refused rather than shown a subset.
For a per-vault view use the `get_metrics` tool, which pins a vault-bound caller to its own vault.

**Breaking for existing remote scrapers.** Before this change any verified token could scrape,
including one minted with `--scopes ""`. Mint a dedicated scrape token and update the scraper:

```sh
obsidian-tc token mint --sub prometheus --scopes admin:metrics
```

```json
{
  "observability": {
    "prometheus": {
      "enabled": true,
      "bind": "127.0.0.1",
      "port": 9464
    }
  }
}
```
