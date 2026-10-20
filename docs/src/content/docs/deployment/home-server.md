---
title: Home server
description: Run obsidian-tc on a home server with Umbrel, CasaOS / ZimaOS or Unraid, from the templates in deploy/homeserver, on your local network with a bearer token.
---

:::caution
These templates need obsidian-tc v1.34.0 or later. Until v1.34.0 is published, `:latest` is v1.33.1, which does not read the `OBSIDIAN_TC_ALLOWED_HOSTS` and `OBSIDIAN_TC_AUDIENCE` settings the templates rely on, so the app will not start. Once v1.34.0 is out, `:latest` works; pin the exact version for production.
:::

The repository ships three templates under `deploy/homeserver/`: an Umbrel community app, a CasaOS /
ZimaOS compose app and an Unraid Community Applications XML. All three run the same published image as
[`compose.http.yml`](/deployment/docker/#http-server), read the same config file and listen on port
8765. They are for a LAN: the server is reachable from your home network and from nowhere else.

Hosted clients such as claude.ai and ChatGPT call the server from the vendor's cloud, so they cannot
reach a LAN address. For those, see [Remote access](#remote-access).

A drift test (`packages/server/test/deploy-homeserver-templates.test.ts`) checks each template against
`compose.http.yml`: the image, the port, the environment, the `/data` and vault mounts, the config file
where the platform can carry one, and the security defaults below. It does not install anything on a
home server, so the install steps are unverified until you run them on your device.

## What every template sets

| Item | Value |
| --- | --- |
| Image | `ghcr.io/the-40-thieves/obsidian-tc:latest`, published for linux/amd64 and linux/arm64 |
| Vault | your existing vault folder, mounted read-write at `/vault`, the value of `OBSIDIAN_TC_VAULT_PATH` |
| Cache | a volume at `/data`, with `OBSIDIAN_TC_CACHE_DIR=/data/cache`, kept apart from the vault |
| Config file | `/config/obsidian-tc.config.json`, the shipped HTTP settings (`auth.mode` `jwt`, `transports.stdio` off, host `0.0.0.0`) |
| `PORT` | `8765` |
| `OBSIDIAN_TC_JWT_SECRET` | a secret you supply, never a value in the template (Umbrel derives one per install) |
| `OBSIDIAN_TC_ALLOWED_HOSTS` | the exact `host:port` you type in the browser. Never `*` |
| `OBSIDIAN_TC_AUDIENCE` | the same address as an `http://` URL. A non-loopback JWT server needs an audience when there is no https public URL |
| `OBSIDIAN_TC_PUBLIC_URL` | not set. It must be `https://`, and a LAN default has no such address |
| Health check | inherited from the image: `HEALTHCHECK` probes `/healthz`. No platform health check is added |

The template does not use the bundled authorization server. The server signs tokens with the JWT
secret, so you mint client tokens yourself (see [Minting a token](#minting-a-token)). Bearer auth
over plain http is only as safe as your network, which is why [Security notes](#security-notes) say to
use a tunnel for anything beyond your own LAN.

## Umbrel

The Umbrel template is a community app store layout: `deploy/homeserver/umbrel/` holds
`umbrel-app-store.yml` and one app directory, `thieves-obsidian-tc/`, with `umbrel-app.yml`,
`docker-compose.yml`, `exports.sh` and an empty `data/vault` directory. The store id `thieves` prefixes
the app id, as community stores require.

1. Publish `deploy/homeserver/umbrel/` as the root of a git repository, because umbrelOS reads
   `umbrel-app-store.yml` from the top of a repository. This repository holds it in a subdirectory, so
   the store cannot be added from this repository's URL as it stands.
2. In umbrelOS, open the App Store, choose Community App Stores and add that repository's URL.
3. Install **obsidian-tc**. Then open the app's Settings and pick your vault folder under the
   `Obsidian vault` entry (umbrelOS 2.0 `folderAccess`). Until you pick one, the app uses an empty
   default vault.
4. The JWT secret is derived by `exports.sh` with `derive_entropy`, so it is stable for the install and
   survives updates.

The app's `app_proxy` lets the MCP paths (`/mcp`, `/mcp/*`) and the `/.well-known/*` metadata through
without the Umbrel login (`PROXY_AUTH_WHITELIST`). MCP clients send a bearer token, not the Umbrel login
cookie, so they could not pass the login otherwise. The server's own JWT check guards those paths; every
other path stays behind the Umbrel login. The template does not set `PROXY_AUTH_ADD: "false"`, which
would make the whole app public.

Allowed hosts default to `<DEVICE_DOMAIN_NAME>:8765` and `<DEVICE_HOSTNAME>:8765`, which is the
`umbrel.local` name by default. An IP address is not in the list. The template exposes no setting for it,
so reaching the app by IP needs a change to the app's environment that these templates do not provide.

## CasaOS / ZimaOS

`deploy/homeserver/casaos/docker-compose.yml` is one compose file with a top-level `x-casaos` block.
Add it as a custom compose app, or publish it as a store app.

1. Import the file. In the install dialog, set:
   - `OBSIDIAN_TC_JWT_SECRET`: a value from `openssl rand -hex 32`.
   - `OBSIDIAN_TC_ALLOWED_HOSTS` and `OBSIDIAN_TC_AUDIENCE`: the host name or IP and port you type in the
     browser, for example `tower.local:8765` and `http://tower.local:8765`. Use the same host in both.
   - The vault bind mount: change its host path from `/DATA/Documents/ObsidianVault` to your vault folder.
2. Start the app. Its address is `http://<host>:8765`.

The config file is delivered with the compose file, so there is nothing to copy. The secret stays empty
until you fill it in. The server's boot check should refuse to start with an empty secret (see
[Secrets](#secrets)).

## Unraid

`deploy/homeserver/unraid/obsidian-tc.xml` is a Community Applications template. Unraid's XML cannot carry
a file, so the config file is one step you do by hand.

1. Create the folder `/mnt/user/appdata/obsidian-tc/config` and copy
   `deploy/config/obsidian-tc.config.json` from the repository into it as `obsidian-tc.config.json`.
2. Add the container from the template URL, or from the template file once it is in your Docker
   templates folder. Set:
   - **Vault folder**: your vault folder. It has no default, so you must choose one.
   - **JWT secret**: a value from `openssl rand -hex 32`. The field is masked.
   - **Allowed hosts** and **Audience**: as for CasaOS, the host and port you type in the browser.
3. Start the container. The cache lives at `/mnt/user/appdata/obsidian-tc/data`.

The template uses bridge networking and no privileges. The Unraid template keeps the image's own health
check and adds none.

## Secrets

The JWT secret is the only credential, and no template puts a literal value in a file:

- Umbrel derives it per install with `derive_entropy`.
- CasaOS and Unraid ship it empty and required. Unraid masks the field. Generate one with
  `openssl rand -hex 32` and paste it in.

An empty secret is not a default. With no secret, no JWKS and no registry key, the server's source refuses
to start with `auth.mode is 'jwt' but there is no signing key`, so an empty secret should not run
unauthenticated. This is read from the source and not yet run on a device. The secret must be at least
32 characters.

## Minting a token

Clients need a bearer token. Mint one inside the running container, with the same config and secret the
server uses:

```sh
docker exec -it <container> bun /app/packages/server/dist/cli.js token mint /config/obsidian-tc.config.json --sub my-client --vault main --scopes read:vault
```

The container name is `thieves-obsidian-tc_main_1` on Umbrel, `obsidian-tc-obsidian-tc-1` under CasaOS
and `obsidian-tc` on Unraid. On Unraid you can also open the container's Console from the Docker tab.
This project has not checked a console in the Umbrel or CasaOS app pages, so run the command over SSH on
the device. Give
each client its own `--sub` and the narrowest `--scopes` it needs. The same command with `--vault` left
out mints a token with no vault binding.

## Connecting a local client

Point the client at `http://<host>:8765/mcp` and send the token in an `Authorization: Bearer <token>`
header. The exact flag depends on the client; see [Client recipes](/deployment/client-recipes/) for the
forms the project has checked. Use the same host name you put in `OBSIDIAN_TC_ALLOWED_HOSTS`, because the
server refuses any other `Host` header.

## Remote access

Put the server behind a tunnel to reach it from outside your network, and give it an `https://` address.

- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) serve the app on a public `https://` host.
- Set `OBSIDIAN_TC_PUBLIC_URL` to that origin, with no path. Remove `OBSIDIAN_TC_AUDIENCE`, because the
  public URL then sets the audience, and keep the host in `OBSIDIAN_TC_ALLOWED_HOSTS` or add it to
  `transports.http.allowedHosts` in the config.
- Hosted connectors (claude.ai, ChatGPT and the others) need this public https address. The steps and
  requirements are in [Hosted clients](/deployment/hosted-clients/). Check with `obsidian-tc doctor --probe`.

The Umbrel template has no field for the public URL, so these templates do not cover remote access on
Umbrel.

## Security notes

- **Plain http on a shared LAN can be sniffed.** A bearer token sent over `http://` can be read by anyone
  on the same network segment. On a network you do not control, use a tunnel with https.
- **Use a fixed address.** The allow-list is exact, so a DHCP address that changes breaks every client.
  Give the server a DHCP reservation, or use a host name that resolves to it.
- **The allow-list is exact.** Entries are `host` or `host:port`. The templates never use `*`, and the
  server rejects a `Host` header that is not on the list.
- **Keep the secret out of logs and screenshots.** The Unraid field is masked. Rotating the secret
  invalidates every token minted with the old one, so mint new tokens afterwards.
- **Scope the tokens.** Mint one per client with the scopes and vault it needs, not `*`.

## What this does not do yet

- **Not verified on a live device.** The templates were checked against the upstream formats and against
  `compose.http.yml` by the drift test, not by installing them. Each platform's install is a manual check.
- **Unverified platform assumptions the templates depend on:**
  - Umbrel: `manifestVersion: 2.0` with `folderAccess` and `storage.dataRoot`; `PROXY_AUTH_WHITELIST` taking
    the glob paths above; `DEVICE_DOMAIN_NAME` and `DEVICE_HOSTNAME` being set in the compose file and
    matching the Host header the app sees; whether umbreld forwards the typed Host header unchanged;
    `derive_entropy` giving a value of at least 32 characters; the app's `data` directory being writable
    by uid 1000; umbrelOS accepting a compose `configs:` entry with `content`; the `submission` field.
  - CasaOS: that the installer accepts a compose `configs:` entry with `content`, and that `$AppID` in the
    bind mount expands at install.
  - Unraid: that the template URL resolves once this file is merged to `main`.
  - All three: that `OBSIDIAN_TC_ALLOWED_HOSTS` and `OBSIDIAN_TC_AUDIENCE` are read as described here. Both
    are settings the templates need from v1.34.0 onwards.
- **Not submitted to any store.** The Umbrel official store needs a landing page the server does not serve,
  pinned image digests, and multi-arch images, none of which these templates have. The CasaOS store needs
  an icon, and this repository ships none. Unraid's Community Applications needs a `ca_profile.xml` and a
  public repository of its own.
- **Umbrel's store is not at this repository's root.** See the Umbrel steps above.
- **The templates track `:latest`.** Pin a version for production.
