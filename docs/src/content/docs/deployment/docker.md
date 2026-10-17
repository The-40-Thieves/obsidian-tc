---
title: Docker
description: Run the published image over stdio or as a long-lived authenticated HTTP server.
---

The published image is `ghcr.io/the-40-thieves/obsidian-tc:latest`. Use `:latest` to follow the
current release, or replace it with `:<version>` when a deployment must stay on one release.

## Stdio

For an MCP client that starts one process per session, keep stdin open and mount the vault:

```sh
docker run -i --rm \
  -v /absolute/path/to/vault:/vault \
  ghcr.io/the-40-thieves/obsidian-tc:latest /vault
```

The repository's root `docker-compose.yml` is the configurable stdio form. Point
`OBSIDIAN_VAULT_PATH` at the host vault, create the config described in that file's header, then
run:

```sh
docker compose run --rm obsidian-tc
```

Do not use the root Compose file with `up -d`; it deliberately models a stdio session rather than
a network service.

## HTTP server

[`deploy/compose.http.yml`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/deploy/compose.http.yml)
runs the image as a long-lived HTTP service. From the repository's `deploy/` directory:

```sh
export OBSIDIAN_TC_PUBLIC_URL=https://vault.example.com
export OBSIDIAN_TC_JWT_SECRET='replace with a random secret of at least 32 characters'
# Optional; 8765 is the documented default.
export PORT=8765

docker compose -f compose.http.yml up -d
docker compose -f compose.http.yml cp /absolute/path/to/vault/. obsidian-tc:/data/vault
```

The named volume has this layout:

- `/data/vault` — the `main` vault;
- `/data/cache` — indexes, model data, and the authentication registry.

On first use, Docker initializes the named volume from the image, including both directories with
ownership for the image's unprivileged `bun` user. The Compose file mounts `./config` as a read-only
directory so replacing the config file does not leave a bind mount pinned to the old inode.

The shipped config sets `transports.http.host` to `0.0.0.0` because the default loopback bind is not
reachable through Docker port publishing. It also sets `transports.stdio` to `false` because a
detached HTTP container has no stdio client. Neither setting has an environment overlay.

`OBSIDIAN_TC_PUBLIC_URL` is required. It derives `auth.resource` as the public origin plus `/mcp`
and adds the public hostname to `allowedHosts`; without an audience/resource, the loader refuses a
JWT server bound to `0.0.0.0`. `OBSIDIAN_TC_JWT_SECRET` is also required by this HS256 setup.

Mint a client token inside the running container. The command inherits the same config, secret,
resource, cache, and vault path as the server:

```sh
docker compose -f compose.http.yml exec obsidian-tc \
  bun /app/packages/server/dist/cli.js token mint /config/obsidian-tc.config.json \
  --sub my-client --vault main --scopes read:vault
```

Send the printed token as `Authorization: Bearer <token>` to
`$OBSIDIAN_TC_PUBLIC_URL/mcp`. Add only the scopes that client needs.

### Healthcheck behavior

The image probes `http://127.0.0.1:${PORT:-8765}/healthz` every 30 seconds, with a 10-second timeout,
a 60-second start period, and three retries. A 200 response is healthy. When `PORT` is set, refusal,
timeout, and every non-200 response are unhealthy. When `PORT` is unset, connection refusal is
healthy so a long-running stdio-only container is not restarted merely because it has no HTTP
listener; timeouts and non-200 responses still fail. `/healthz` is unauthenticated liveness only.

The Compose file inherits this image healthcheck and does not duplicate it.

## Platform bundles

- [Railway](/deployment/railway/) — repository Dockerfile, volume, environment, and Railway health
  check configuration.
