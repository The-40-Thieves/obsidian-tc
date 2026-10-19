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

## Git-backed vault (`-git` image)

The `-git` variant keeps the vault in step with a Git remote. It is the default image plus `git` and
`openssh-client`, about 165 MB (157 MiB) larger, measured on the first `-git` build. The default image
is unchanged and has neither tool.

Its tags follow the same scheme with a suffix: `ghcr.io/the-40-thieves/obsidian-tc:<version>-git`,
and `:latest-git` for the current release. **The `-git` tags are first published with the next
release.** Before that, build the image from a checkout with `docker build --target git -t obsidian-tc:git .`.

The entrypoint is `obsidian-tc git-sync --supervise`. It clones the remote into `/data/vault` (or
verifies an existing clone), runs one pull, and starts the server as a child process. Arguments
after `--` go to the server, as in `git-sync --supervise -- <server args>`. With no arguments, the
server reads its configuration from the environment, as in the HTTP example above.

```sh
docker run -d --name obsidian-tc --restart unless-stopped \
  -p 8765:8765 \
  -v obsidian-tc-data:/data \
  -v /absolute/path/to/deploy/config:/config:ro \
  -e OBSIDIAN_TC_CONFIG=/config/obsidian-tc.config.json \
  -e OBSIDIAN_TC_VAULT_PATH=/data/vault \
  -e OBSIDIAN_TC_CACHE_DIR=/data/cache \
  -e PORT=8765 \
  -e OBSIDIAN_TC_PUBLIC_URL=https://vault.example.com \
  -e OBSIDIAN_TC_JWT_SECRET \
  -e OBSIDIAN_TC_VAULT_GIT_URL=git@github.com:org/vault.git \
  -e OBSIDIAN_TC_VAULT_GIT_SSH_KEY \
  ghcr.io/the-40-thieves/obsidian-tc:latest-git
```

A bare `-e NAME` passes the variable from the calling shell, so the SSH key and the JWT secret stay
off the command line. `OBSIDIAN_TC_VAULT_GIT_SSH_KEY` holds the private key contents. For an HTTPS
remote, pass `OBSIDIAN_TC_VAULT_GIT_TOKEN` instead. The variables and their defaults are in
[docs/SYNC.md](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/SYNC.md#git-kept-in-sync-by-the-server-the--git-image).

For Compose, [`deploy/compose.git.yml`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/deploy/compose.git.yml)
is the `-git` sibling of `compose.http.yml`. It has the same volume and config layout and reads the
SSH key from the environment.

**Health and restart.** The image healthcheck described above probes only the server's `/healthz`.
A sync failure does not fail it: the sidecar records the error in `status.json` under the state
directory, `/data/cache/git-sync`, writes it to stderr, and retries on the next tick. The container
exits when either process exits: the server, or the sync loop if it stops with an error. A boot
refusal, such as a directory that holds files but is not a clone of the remote, exits before the
server starts. The restart policy then restarts the container, so set `--restart unless-stopped` as above.

## Platform bundles

- [Render](/deployment/render/) — Blueprint, persistent disk, generated setup token, and Render health
  check configuration.
- [Railway](/deployment/railway/) — repository Dockerfile, volume, environment, and Railway health
  check configuration.
- [Fly.io](/deployment/fly/) — `fly.toml` with the published image, one volume, and a `/healthz` check.
- [VPS (cloud-init)](/deployment/vps/) — Ubuntu 24.04 user data with Docker, Caddy and a generated JWT secret.
