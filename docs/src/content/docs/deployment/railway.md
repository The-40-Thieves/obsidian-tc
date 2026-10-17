---
title: Railway
description: Run obsidian-tc as a container on Railway with one volume, environment variables and a config file.
---

The image's ENTRYPOINT boots the server from `OBSIDIAN_TC_CONFIG`. Railway builds the repository's
`Dockerfile` (`railway.json` at the repository root selects it), and the server serves HTTP on the
port Railway injects as `PORT`. Nothing here needs a shell on the host: the config file and the
secrets are supplied as described below.

## Environment precedence

For every variable in the table below, the order is **environment over config file over default**.
An empty variable counts as unset, so `PORT=""` changes nothing. The overlays run inside the same
config loader the server boots with, so `config explain` reports which variable supplied each value.

## Config file

Put the config file on the volume and point `OBSIDIAN_TC_CONFIG` at it. This page does not ship a
template; the file is yours to write. A working starting point, with the paths used below:

```json
{
  "cacheDir": "/data/cache",
  "vaults": [{ "id": "main", "path": "/data/vault" }],
  "transports": {
    "stdio": false,
    "http": { "host": "0.0.0.0", "allowedHosts": ["vault.example.com"] }
  },
  "auth": {
    "mode": "jwt",
    "resource": "https://vault.example.com/mcp",
    "requireJti": true
  }
}
```

Two settings belong in the file and have no environment overlay:

- `transports.http.host` must be `0.0.0.0`. The default `127.0.0.1` is reachable only from inside the
  container, and Railway's proxy cannot reach it. `PORT` deliberately does not change the bind
  address, so a laptop that sets `PORT` is not exposed to its network.
- `transports.stdio` must be `false`. Railway gives the container no stdin, so the stdio transport
  would see an immediate end of input on every boot.

## Environment variables

| Name | Config path | Required | Secret |
| --- | --- | --- | --- |
| `OBSIDIAN_TC_CONFIG` | selects the config file | yes | no |
| `PORT` | `transports.http.port`; also sets `transports.http.enabled` to `true` unless the file sets it to `false` | yes on Railway, which injects it | no |
| `OBSIDIAN_TC_PUBLIC_URL` | `auth.resource` (the origin plus `/mcp`) and the host appended to `transports.http.allowedHosts` | recommended; without it, set `auth.resource` in the file | no |
| `OBSIDIAN_TC_VAULT_PATH` | `vaults`: the path of the one vault | optional when the file names exactly one vault; refused when it names several | no |
| `OBSIDIAN_TC_CACHE_DIR` | `cacheDir` | optional when the file sets it | no |
| `OBSIDIAN_TC_JWT_SECRET` | `auth.jwtSecret` | required for `auth.mode` `jwt` without a JWKS key source | yes |
| `OBSIDIAN_TC_JWKS_URI` | `auth.jwksUri` | optional; for an external authorization server | no |
| `OBSIDIAN_TC_AS_SETUP_TOKEN` | named by `auth.as.setupTokenEnv` | only for claiming the bundled authorization server | yes |
| `OBSIDIAN_TC_AS_RESET_TOKEN` | named by `auth.as.resetTokenEnv` | only for a password reset | yes |
| the variable named by `embeddings.apiKeyEnv` | `embeddings.apiKeyEnv` | when a hosted embeddings provider is used | yes |

`OBSIDIAN_TC_PUBLIC_URL` must be `https://host` or `https://host:port`, with no path, query or
credentials. Anything else refuses to boot, and the error names the variable without echoing its
value.

`PORT` must be a whole number from 1 to 65535. A non-loopback host with `auth.mode` `none` is
refused at load, so a container that binds `0.0.0.0` without authentication does not start.

## Volume

Mount one volume at `/data`, then point the variables at it:

- `OBSIDIAN_TC_VAULT_PATH=/data/vault`
- `OBSIDIAN_TC_CACHE_DIR=/data/cache`
- `OBSIDIAN_TC_CONFIG=/data/config.json`

The container runs as the unprivileged `bun` user (uid 1000). The volume must be writable by that
user, or the first boot cannot create the cache.

## Authentication

Pick one of the two modes. Both need `auth.mode` set to `jwt` in the file.

- **Bundled authorization server.** Enable `auth.as` as described in
  [Turning it on](/security/auth-model/#turning-it-on). Its issuer is set in the file. Claim the
  operator account with the one-time token in `OBSIDIAN_TC_AS_SETUP_TOKEN`, and set a new password
  with `OBSIDIAN_TC_AS_RESET_TOKEN` when the host has no shell. Remove both variables once they
  have done their job.
- **JWT with a minted token.** Set `OBSIDIAN_TC_JWT_SECRET` in Railway and mint tokens against the
  same config and secret, with `obsidian-tc token mint`, on any machine that has them. Keep the
  secret out of the file.

## Embeddings

The default embeddings provider, `local`, runs a model bundled in the image and needs `cacheDir`,
which the config file already sets. A hosted provider avoids the model download. Name the key's
environment variable with `apiKeyEnv` and store the key itself in Railway:

```json
{
  "embeddings": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536,
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

See [Embeddings](/configuration/embeddings/) for the other providers.

## What this does not do yet

- **No published template and no Deploy button.** Publishing one needs the owner's Railway account.
- **No git-backed vault sync.** The vault on the volume is the only copy this deployment reads. Keeping
  it in step with a repository is a separate design.
- **Liveness health check.** `railway.json` sets `healthcheckPath: /healthz`; it is liveness only, and
  `allowedHosts` must include the Railway hostname or the probe gets 403.
- **No refusal of public boot for the other modes.** Only the non-loopback, unauthenticated
  combination above is refused.
