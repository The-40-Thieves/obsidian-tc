---
title: Fly.io
description: Deploy obsidian-tc on Fly.io from fly.toml, with one volume at /data, generated secrets and a health check.
---

The repository's `fly.toml` is a Fly.io app config. `fly launch --from` creates an app from it: one
Machine runs the published image `ghcr.io/the-40-thieves/obsidian-tc:latest` with a volume mounted at
`/data`. The image's ENTRYPOINT boots the server from `OBSIDIAN_TC_CONFIG`, which the deploy copies in
from the repository, and the server serves HTTP on port 8765.

The app uses the image rather than building the repository's `Dockerfile`, so the release that CI
tested is the one that runs, and Fly runs no build.

## What `fly.toml` sets

| Item | Value | Why |
| --- | --- | --- |
| `[build] image` | `ghcr.io/the-40-thieves/obsidian-tc:latest` | Deploys an existing image, with no build step. |
| `[env]` `OBSIDIAN_TC_CONFIG` | `/config/obsidian-tc.config.json` | The config file the deploy copies in (see `[[files]]`). |
| `[env]` `OBSIDIAN_TC_VAULT_PATH` | `/data/vault` | The vault, on the volume. |
| `[env]` `OBSIDIAN_TC_CACHE_DIR` | `/data/cache` | The cache, on the volume. |
| `[env]` `PORT` | `8765` | The port the server listens on. |
| `[[files]]` | `deploy/config/obsidian-tc.config.json` to `/config/obsidian-tc.config.json` | The shared HTTP config: `0.0.0.0` bind, stdio off, JWT auth. Fly copies it into the Machine at deploy time, from the directory of `fly.toml`. |
| `[mounts]` | `obsidian_tc_data`, mounted at `/data`, `initial_size = "10gb"` | The volume holds the vault and the cache. A volume can be grown but not shrunk. `initial_size` applies only when `fly launch` or `fly deploy` creates the volume. |
| `[http_service]` `internal_port` | `8765` | Matches `PORT`. |
| `[http_service]` `force_https` | `true` | Plain HTTP is redirected to HTTPS. |
| `[http_service]` `auto_stop_machines` | `"off"` | The proxy never stops the Machine. The server keeps its SQLite database on one volume and runs as one Machine, so the proxy must not stop it. |
| `[http_service]` `min_machines_running` | `1` | It has no effect while stopping is off. It stays as a guard in case someone turns stopping on later. |
| `[[http_service.checks]]` | `GET /healthz`, every 30 s, 10 s timeout, 60 s grace period | Liveness only. The check runs against the Machine over Fly's private network, not against `<app>.fly.dev`. |
| Check `headers` `Host` | `localhost` | The check's Host is the Machine's private address, which the server's DNS-rebinding guard refuses. `localhost` is always allowed. |
| `[[vm]]` | `shared-cpu-1x`, `2gb` | The same 2 GB as the Render Blueprint: the server is about 430 MB idle, and indexing peaks above that. |

`/healthz` is unauthenticated liveness only, so the check needs no token.

## Cost

As listed on [Fly.io's pricing page](https://docs.fly.io/about/pricing) on 2026-10-19, for Ashburn
(`iad`) and Secaucus (`ewr`), the lowest-priced regions:

| item | price |
|---|---|
| `shared-cpu-1x` with 2 GB, per 30 days running | $12.70 |
| Volume, per GB of provisioned capacity per month | $0.15 (the 10 GB volume: $1.50) |

That is about $14.20 per month for the app as written. Prices vary by region and change, so check the
pricing page before you create the app. New organizations have no free tier, only a trial. A volume
is billed whether or not the Machine runs.

## Create the app

1. Run the launch command from a checkout or an empty directory:

   ```sh
   fly launch --from https://github.com/The-40-Thieves/obsidian-tc --copy-config --no-deploy
   ```

   `--from` uses the repository as a template, `--copy-config` keeps its `fly.toml` without prompting,
   and `--no-deploy` stops before the first deploy. Pick the app name and the region when asked.
   `fly launch` writes the app name into `fly.toml`.

2. Set the public URL and the JWT secret as secrets. `--stage` stores them without deploying:

   ```sh
   fly secrets set --stage OBSIDIAN_TC_PUBLIC_URL=https://<app>.fly.dev OBSIDIAN_TC_JWT_SECRET="$(openssl rand -hex 32)"
   ```

   The public URL is not secret. It is set as a secret so that `fly.toml` stays the same for every
   app. The JWT secret must be at least 32 characters; `openssl rand -hex 32` gives 64.

3. Deploy:

   ```sh
   fly deploy
   ```

   With a volume mounted, Fly creates one Machine, not the usual two, because volumes are not
   replicated between Machines. See [Fly's app availability notes](https://docs.fly.io/apps/app-availability).

4. Seed the vault (see [Vault source](#region-and-vault-source)) and mint a client token inside the
   Machine:

   ```sh
   fly ssh console --user bun -C "bun /app/packages/server/dist/cli.js token mint /config/obsidian-tc.config.json --sub my-client --vault main --scopes read:vault"
   ```

   `--user bun` runs the command as the image's unprivileged `bun` user (uid 1000), which is the user the
   server runs as. The default user of `fly ssh console` is root, so without the flag the command
   could leave root-owned files under `/data`, which the server cannot write to. That default is not
   re-checked on a live app here. Send the printed token as
   `Authorization: Bearer <token>` to `https://<app>.fly.dev/mcp`. Add only the scopes that client needs.

## Public URL and custom domain

`OBSIDIAN_TC_PUBLIC_URL` must be `https://host` or `https://host:port`, with no path, query or
credentials. Fly gives each app a `https://<app>.fly.dev` address; set the secret to that origin, or to
your own domain once it is attached to the app. The value sets `auth.resource` (the origin plus `/mcp`)
and is added to `allowedHosts`, so a custom domain must be attached and resolve before clients connect.
After any change of domain, set the secret again and deploy.

## Changing the config

The config file comes from `deploy/config/obsidian-tc.config.json` in the directory `fly deploy` runs
from, and is copied in at deploy time. To change it, edit that file and run `fly deploy`. For example, to
use the `openai` embeddings provider, name it in the file and set `OPENAI_API_KEY` with `fly secrets set`.
See [Embeddings](/configuration/embeddings/).

To use the bundled authorization server instead of minted tokens, see
[Railway's Authentication section](/deployment/railway/#authentication). The config then needs
`auth.as.issuer`, which the shared file does not set.

## Region and vault source

A volume lives on one server in one region, so the Machine stays in that region. Pick the region near
your clients. Fly takes daily snapshots of a volume and keeps them for 5 days by default; the retention
can be set with `snapshot_retention` in `[mounts]`.

The volume is the only copy of the vault that the server reads. To keep the vault in step with a Git
repository, use the `-git` image and the variables in
[Git-backed vault](/deployment/railway/#git-backed-vault-git-image). Those tags are first published with
the next release, so the `-git` image is not yet available for `[build] image`.

## What this does not do yet

- **Not yet verified on a live Fly app.** The fields were checked against Fly's documentation, not by
  creating an app. A live deploy check is still needed.
- **Volume ownership (unverified).** The image creates `/data/vault` and `/data/cache` owned by `bun`,
  but a new Fly volume is mounted over `/data`. If the first boot fails with a permission error on
  `/data`, the volume is not writable by uid 1000. That is an open point, not a known fact about Fly.
  Report it; do not work around it without a fix from the maintainers.
- **Health check Host header (unverified).** The `Host: localhost` override is set in `fly.toml`, and the
  server's guard accepts `localhost`, but no live check has been observed sending that header or passing.
- **`[[files]]` under `fly launch --from` (unverified).** `fly launch --from` clones the repository, and
  the `local_path` is taken relative to the cloned `fly.toml`. That has not been observed on a live app.
- **No deploy button.** Fly has no button equivalent to Render's, so the README has no link for it.
