---
title: OpenAPI clients (mcpo bridge)
description: Expose obsidian-tc tools to OpenAPI-only consumers through the mcpo bridge, with one shared identity.
---

obsidian-tc speaks MCP. It has no OpenAPI or REST surface, and this page does not add one. For
consumers that only speak OpenAPI, such as n8n and Zapier HTTP nodes, scripts, and Open WebUI user
tool servers, run [mcpo](https://github.com/open-webui/mcpo) (v0.0.20) in front of the server. mcpo
turns each MCP tool it reads into an OpenAPI operation.

## When to use it

- A workflow tool calls plain HTTP and cannot speak MCP Streamable HTTP.
- Open WebUI needs a user-added tool server. Open WebUI 0.6.31 and later can connect to MCP
  servers natively with OAuth and a per-user identity, so prefer that path for any user who has an
  account of their own. Use mcpo for the OpenAPI-only cases above.

Do not use the bridge for MCP clients such as Claude Code or claude.ai. They should connect to the
server directly with the [client recipes](/deployment/client-recipes/).

## How it works

mcpo opens **one** MCP session to obsidian-tc when it starts. It sends the static headers given on
its command line, and it reads the tool list once. Every OpenAPI request then runs on that session,
so every caller shares one obsidian-tc identity and that identity's scopes and folder ACL. mcpo
does not forward a caller's own credentials.

Requests reach mcpo with one shared API key, set by `--api-key`. `--strict-auth` applies that key
to the documentation endpoints (`/docs` and `openapi.json`) as well as to the tools.

## Deploy

The overlay `deploy/compose.mcpo.yml` runs on top of the [HTTP bundle](/deployment/docker/). The
order matters, because the overlay's `${...:?}` guards stop the whole project from starting until
the token exists:

1. Start the server alone and wait for it to be healthy:

   ```sh
   docker compose -f compose.http.yml up -d --wait
   ```

2. Mint a token for the bridge inside the running container, using the same command form as the
   [Docker page](/deployment/docker/#healthcheck-behavior):

   ```sh
   docker compose -f compose.http.yml exec obsidian-tc \
     bun /app/packages/server/dist/cli.js token mint /config/obsidian-tc.config.json \
     --sub openapi-bridge --vault main --scopes 'read:*'
   ```

3. Export the token, a random bridge API key, and start the overlay:

   ```sh
   export OBSIDIAN_TC_MCPO_TOKEN='<printed token>'
   export OBSIDIAN_TC_MCPO_API_KEY='<random key for callers>'
   docker compose -f compose.http.yml -f compose.mcpo.yml up -d
   ```

The overlay sets `OBSIDIAN_TC_ALLOWED_HOSTS=obsidian-tc` on the server, so that the bridge's Host
header is accepted. It publishes mcpo on `127.0.0.1:8000` only; set `MCPO_PORT` to change the port.

The bridge connects to `/mcp/essentials`, the curated profile described under
[Choosing a surface](#choosing-a-surface).

## Connect Open WebUI

- **Global tool server** (set by an administrator): the backend calls it. Use
  `http://<host>:8000` as the URL, and the bridge API key as the Bearer token.
- **User tool server** (added by a user in their settings): the browser calls it, so CORS and mixed
  content apply. Serve mcpo over HTTPS on a hostname the browser can reach, and allow the Open WebUI
  origin in front of it. The URL and Bearer token are the same as for a global server.

## Choosing a surface

mcpo's URL selects which MCP endpoint it reads.

| URL path          | What it exposes                                                                    | Use it when                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/mcp/essentials` | The curated, typed, flat tool set                                                  | Default. Use this for the overlay.                                                                             |
| `/mcp/core`       | A smaller curated typed set                                                        | You want the narrowest surface that still covers your workflow.                                                |
| `/mcp`            | The three-tool triad (`find_capability`, `describe_capability`, `call_capability`) | Only for a client that already speaks the triad. Its arguments are untyped, so the OpenAPI schema says little. |
| `/mcp/full`       | Every tool as an OpenAPI operation                                                 | Avoid it. The spec becomes very large and the caller gets every surface at once.                               |

The server filters `tools/list` by the bridge token's scopes, so a caller sees only the tools its
scopes allow.

## What works and what does not

- **Read tools work.** A call such as `read_note` returns HTTP 200 with the note.
- **Confirmation-gated tools fail closed.** mcpo does not implement MCP elicitation, so the server
  sees no elicitation capability. A gated tool returns an error, and mcpo reports it as HTTP 500 with
  `{"detail":{"message":"Unexpected error","error":"500: {'message': \"Error [elicit_required]: human confirmation required ...\"}"}}`
  (the `elicit_required` text sits inside the `error` field). Nothing runs, and nothing is confirmed
  automatically.
- **Shared identity.** Every caller is the same principal, so the folder ACL and the audit trail
  cannot tell callers apart.
- **One API key.** There is one bridge key for all callers. Rotating it means restarting mcpo.
- **Spec hints are partial.** mcpo drops `enum`, `const`, `minimum` and `maximum` from the OpenAPI
  document. The server still validates every argument, so a bad value is rejected, but the generated
  client does not know the constraint.
- **The tool list is fixed at startup.** mcpo reads the tools once. Restart it after a server
  upgrade or after the token's scopes change.
- **Token expiry.** When the token expires, mint a new one, export it, and restart mcpo.
- **Not bridged.** MCP resources, prompts, progress notifications and embedded resources are not
  available through mcpo. Images come back as data URLs.

## Security

- The default token has `read:*` only. Give the bridge write scopes only when a workflow needs
  them, and prefer a separate bridge for each principal that writes.
- The token is passed on mcpo's command line, so anyone who can run `docker inspect` on the host
  can read it. Limit access to the Docker host accordingly.
- The bridge API key and the token are both secrets. Keep both out of workflow definitions that
  other people can read.
- The bridge listens on loopback. Put a reverse proxy with TLS in front of it only when a browser
  must reach it.
