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
listener serves `/metrics` on `prometheus.bind:port`. Authentication follows `auth.mode`, not the
bind address:

- **`auth.mode: jwt` or `oidc`** → a verified bearer that holds the **`admin:metrics`** scope and is
  not bound to a vault or persona is required on **every** bind, **loopback included**. A loopback
  bind cannot tell a local scraper from a caller that a Cloudflare Tunnel, Tailscale Serve, an SSH
  reverse forward or a reverse proxy relayed to `127.0.0.1`, so it is not trusted as "local";
- **`auth.mode: none`, loopback bind** → open, no token needed (the single-user local default);
- **`auth.mode: none`, non-loopback bind** → refused at startup.

The token is verified by the same verifier instance the MCP HTTP transport uses, built once at boot
(every key source: `jwtSecret`, `jwks`, `jwksFile`, `jwksUri`, registry keys; the same audience,
issuer, `algorithms` and `requireJti`; or the OIDC provider under `auth.mode: oidc`). A token the
MCP edge accepts is verified identically here.

On a loopback bind the `Host` header is also checked with the MCP route's DNS-rebinding guard
(`transports.http.enableDnsRebindingProtection`, on by default): a request whose `Host` is not
loopback, the bind host, or listed in `transports.http.allowedHosts` is refused with `403`, before
authentication. If a tunnel or reverse proxy fronts the listener, add the public host name it
forwards (for example `metrics.example.com`) to `transports.http.allowedHosts`, and give the
scraper behind it an `admin:metrics` token, exactly as for a direct remote scrape.

The responses (when authentication is required) are:

| request | status |
|---|---|
| `Host` not allowed (loopback bind) | `403`, before any token is read |
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

**Breaking for existing scrapers under `jwt` / `oidc`.** Before this change any verified token
could scrape a non-loopback bind (including one minted with `--scopes ""`), and a loopback bind
needed no token at all. Mint a dedicated scrape token and update the scraper, loopback or not:

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
