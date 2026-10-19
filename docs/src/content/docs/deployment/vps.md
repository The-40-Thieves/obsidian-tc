---
title: VPS (cloud-init)
description: Set up obsidian-tc on a new Ubuntu 24.04 server from cloud-init user data, with Docker, Caddy, a generated JWT secret and a certificate for your domain.
---

The repository's `deploy/cloud-init.yaml` is cloud-config user data for a new Ubuntu 24.04 server. On
first boot it installs Docker and Compose from Ubuntu's archive, Caddy from Caddy's own apt repository (the key is pinned in the file), writes the shared
[`compose.http.yml`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/deploy/compose.http.yml) and
config file, generates the JWT secret on the server, and starts the server behind Caddy. Caddy gets a
certificate for your domain by itself.

The server runs the published image `ghcr.io/the-40-thieves/obsidian-tc:latest`, not a build of the
repository's `Dockerfile`, so the release that CI tested is the one that runs.

## Before you start

- A domain whose A record points at the server's IPv4 address. Caddy needs it to get a certificate, so
  the record must resolve before the first boot.
- An Ubuntu 24.04 image. The packages and the Caddy setup are written for 24.04 only.
- A provider that accepts cloud-init user data. Providers that accept cloud-init user data include
  DigitalOcean, Hetzner, Vultr and Linode. This page has not been tested on any of them.

## Create the server

1. Open `deploy/cloud-init.yaml` and set `OBSIDIAN_TC_PUBLIC_URL` in the `.env` entry to your origin, for
   example `https://vault.example.com`. Leave the placeholder in place and the script stops, so an
   unedited copy does not start. Use a domain name, not an IP address: Caddy cannot get a certificate for an IP
   address, so the script refuses one.
2. Paste the whole file as the server's user data, and create the server.
3. If the first boot stopped on the placeholder, log in as the provider's default user and edit
   `/opt/obsidian-tc/deploy/.env`, then run `sudo /opt/obsidian-tc/bootstrap.sh`. The script is safe to
   re-run.

## What it writes

| Path | Content | Mode |
| --- | --- | --- |
| `/opt/obsidian-tc/deploy/.env` | `OBSIDIAN_TC_PUBLIC_URL` and the generated `OBSIDIAN_TC_JWT_SECRET` | `0600` |
| `/opt/obsidian-tc/deploy/compose.http.yml` | The shared Compose file, byte-for-byte | `0644` |
| `/opt/obsidian-tc/deploy/config/obsidian-tc.config.json` | The shared HTTP config, byte-for-byte | `0644` |
| `/opt/obsidian-tc/deploy/compose.vps.yml` | Binds the published port to `127.0.0.1`, so only Caddy reaches the server | `0644` |
| `/opt/obsidian-tc/bootstrap.sh` | The script that generates the secret, writes the Caddyfile and starts the containers | `0755` |

The script also writes `/etc/caddy/Caddyfile` with your domain and a `reverse_proxy` to
`127.0.0.1:8765`, with `flush_interval -1` so streamed responses are not held back. The port is fixed at
8765: `.env` does not set `PORT`, and the Caddyfile and the loopback bind both use that port.

The JWT secret is generated on the server with `openssl rand -hex 32` and written to `.env`, which is
readable by root alone. Docker also keeps it in the container's configuration, which only root can read. It is never printed. The console log, which cloud-init also writes to
`/var/log/cloud-init-output.log`, shows the URL and the mint command only.

## First token

When the script finishes, it prints the command that mints a client token. The command runs inside the
container, so it uses the same config, secret and vault as the server:

```sh
cd /opt/obsidian-tc/deploy && docker compose -p obsidian-tc -f compose.http.yml -f compose.vps.yml exec obsidian-tc bun /app/packages/server/dist/cli.js token mint /config/obsidian-tc.config.json --sub my-client --vault main --scopes read:vault
```

Send the printed token as `Authorization: Bearer <token>` to `https://<your domain>/mcp`. Add only the
scopes that client needs.

To check the first boot, run `sudo cloud-init status --wait`, then `sudo tail /var/log/cloud-init-output.log`.

## Firewall

Allow ports 22, 80 and 443 only. Port 80 is for Caddy's certificate challenge and its redirect to HTTPS.
The server's own port is bound to `127.0.0.1` by `compose.vps.yml`, so the internet cannot reach it
directly. Use the provider's cloud firewall, which filters traffic before it reaches the server.

## TLS and client IP addresses

The bundle uses Caddy as written. Caddy gets and renews the certificate itself once the A record
resolves. If you use a Cloudflare Tunnel instead, follow
[Cloudflare tunnel](/deployment/hosted-clients/#cloudflare-tunnel), and then drop Caddy.

Caddy connects to the server's published port on `127.0.0.1`, but Docker forwards that connection from the
bridge gateway of the Compose network, so the server sees each connection as coming from the gateway, not
from `127.0.0.1`. Measured on Docker 29.9.1: a container published on `127.0.0.1` saw `::ffff:172.20.0.1`,
which is the IPv4 gateway `172.20.0.1`. Docker picks the gateway when the network is created, so read this
server's value after `up`:

```sh
docker network inspect obsidian-tc_default -f '{{(index .IPAM.Config 0).Gateway}}'
```

If
per-client IP addresses matter, add that gateway address to `transports.http.trustedProxies` in the config
file, with the default `forwardedHeader: x-forwarded-for`, as described in
[Caddy](/deployment/hosted-clients/#caddy). Edit `/opt/obsidian-tc/deploy/config/obsidian-tc.config.json`,
then run `docker compose -p obsidian-tc -f compose.http.yml -f compose.vps.yml restart obsidian-tc` so the
server reads it again. This restart step has not been verified on a live server.

## Seeding the vault and backups

Seed the vault with the copy command from the [Docker page](/deployment/docker/#http-server), using the
project and files of this bundle:

```sh
cd /opt/obsidian-tc/deploy && docker compose -p obsidian-tc -f compose.http.yml -f compose.vps.yml cp /absolute/path/to/vault/. obsidian-tc:/data/vault
```

The data lives in the named volume `obsidian-tc_obsidian-tc-data`. Back it up with your provider's server
snapshots, or stop the container and archive the volume. Keep `.env` with the backup too: it holds the
secret that every minted token depends on. A restored server without the same secret cannot verify tokens
minted before the restore.

## What this does not do yet

- **Not yet verified on a live server.** The file was checked with `cloud-init schema`, and the Compose merge
  was checked with `docker compose config`, which shows the loopback bind. It has not been run on a real
  server, so the first boot, the certificate and the first token are unverified.
- **Ubuntu 24.04 only.** Other releases are not supported by this file.
- **No Marketplace image.** The bundle is user data for a plain server. There is no prebuilt image for any
  provider.
