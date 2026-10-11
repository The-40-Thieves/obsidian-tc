---
title: Client recipes
description: Setup for each MCP client against the bundled authorization server, bring-your-own recipes for WorkOS AuthKit and Keycloak 26.7, and what is not supported yet.
---

Each recipe connects one MCP client to a server you run. The bundled authorization server is the default. WorkOS AuthKit and Keycloak are the vetted outside alternatives. The settings are explained in [Authentication](/security/auth-model/) and [Configuration](/configuration/config-yaml/).

**Nothing on this page has been checked with a live login yet.** Every client carries one tag:

- **verified**: a live login was done and the steps worked. None yet.
- **documented**: the vendor's own docs describe the setup. The steps have not been run here.
- **unverified**: no vendor page we read confirms the setup. It comes from the research note only and may be wrong.

The **Last live check** column is for the owner's live run and is left blank.

Server side, for every client on the bundled server: `auth.mode: jwt`, `auth.as.enabled: true`, `auth.resource` set to the MCP URL, and `auth.as.issuer` set to the server's origin. Dynamic Client Registration is on by default (`auth.as.dynamicRegistration`). A client that uses only a metadata document does not need it.

## Bundled authorization server

### Tier 1: metadata document or DCR

| Client | Tag | Registration | Last live check |
| --- | --- | --- | --- |
| Claude Code | documented | Metadata document, found automatically; DCR when the server does not advertise one | |
| claude.ai custom connector | documented | Metadata document when `none` and `client_id_metadata_document_supported` are advertised, otherwise DCR | |
| ChatGPT developer mode | unverified | Metadata document preferred, DCR as the fallback | |
| Codex (`codex mcp login`) | documented | Metadata document when `none` is advertised, otherwise DCR | |

#### Claude Code

```bash
claude mcp add --transport http <name> https://vault.example.com/mcp
claude mcp login <name>
```

Inside Claude Code, `/mcp` starts the same browser sign-in. If a server needs an exact redirect port, add `--callback-port <port>`.

#### claude.ai custom connector

Add a custom connector with the MCP URL and sign in. Claude's redirect is `https://claude.ai/api/mcp/auth_callback`. The bundled server answers Claude's metadata-document requirements (`none`, and `client_id_metadata_document_supported`). The add-connector steps are not on the page we read, so check them on the first live run. Team and Enterprise owners add the connector for their organization.

#### ChatGPT developer mode

Unverified. The ChatGPT MCP page we read covers the desktop app, not developer mode. In the desktop app, open Settings, select MCP servers, add a Streamable HTTP server with the MCP URL, then select Authenticate. The bundled server returns `iss` on every authorization response, which is what makes ChatGPT use its stable redirect URI, `https://chatgpt.com/connector_platform_oauth_redirect` (research note only).

#### Codex

```bash
codex mcp add <name> --url https://vault.example.com/mcp
codex mcp login <name>
codex mcp login <name> --oauth-client-registration cimd
codex mcp login <name> --oauth-client-registration dcr
```

The default registration mode is `auto`: a metadata document when the server advertises one and the callback is loopback, otherwise DCR. `codex mcp add ... --oauth-client-id <id>` uses a pre-registered client and skips registration; add that client under `auth.as.clients`. The Codex page says Codex appends a server-specific ID to its callback path (`http://127.0.0.1/callback/<id>`). Whether the bundled server accepts that path has not been tested, so check it on the first live run.

#### Gemini CLI

Gemini CLI registers by DCR, and its page does not mention a metadata document. Keep `auth.as.dynamicRegistration` on for it. In `settings.json`:

```json
{
  "mcpServers": {
    "vault": {
      "httpUrl": "https://vault.example.com/mcp",
      "oauth": { "enabled": true }
    }
  }
}
```

Then run `/mcp auth vault` inside the CLI. The research note says Gemini CLI stopped serving personal accounts on 2026-06-18.

### Tier 2: DCR or pre-registered only

| Client | Tag | Registration | Last live check |
| --- | --- | --- | --- |
| Antigravity | unverified | DCR, automatic. Its `/register` call must get `201` | |
| Grok Build | unverified | Registers itself; the metadata-document or DCR path is not confirmed | |
| Cursor | unverified | DCR, with a fixed callback `http://localhost:8787/callback` | |
| VS Code (Copilot) | unverified | Metadata document (research note); the MCP page we read does not cover OAuth | |
| Zed | unverified | Metadata document (research note), then DCR | |

Grok Build's add command, from the research note, is `grok mcp add --transport http <name> <url>`. VS Code takes the server in `.vscode/mcp.json` under `servers`, with `"type": "http"` and `url`. Zed takes it under `context_servers` with `url`. None of these forms is confirmed by a page we read.

### Tier 3: bearer-only APIs

These send a token and run no OAuth flow, and they do not refresh. A token from the bundled server lasts `auth.as.accessTokenSeconds` (1800 by default), so use a token you mint for the API and keep its lifetime in mind.

| Surface | Tag | Form | Last live check |
| --- | --- | --- | --- |
| Claude Messages API (MCP connector) | unverified | `mcp_servers` entry with `authorization_token` (research note) | |
| OpenAI Responses and Agents SDK | unverified | MCP tool with `authorization` (research note) | |
| xAI API | unverified | `server_url` with `authorization` (research note) | |

## Bring your own authorization server

### WorkOS AuthKit

Tag: **documented** (WorkOS AuthKit MCP guide). Keep the bundled server off: `auth.as.enabled` stays `false`.

1. In the WorkOS dashboard, under Connect and then Configuration, turn on Client ID Metadata Documents. It is off by default. Turn on Dynamic Client Registration only for a client that needs it.
2. Add the MCP URL as a Resource Indicator and set it as the default with "Set as default". The default applies to clients that omit `resource`, and only to metadata-document or DCR clients. A wildcard indicator cannot be the default.
3. Point obsidian-tc at AuthKit:

```yaml
auth:
  mode: jwt
  resource: https://vault.example.com/mcp
  audience: https://vault.example.com/mcp
  issuer: https://<authkit-domain>
  jwksUri: https://<authkit-domain>/oauth2/jwks
  authorizationServers:
    - https://<authkit-domain>
```

The `issuer` must equal the `iss` in AuthKit's tokens, so copy the value your environment shows. The JWKS URL is `https://<authkit-domain>/oauth2/jwks`. With `resource` set by the client, `aud` is the MCP URL. Without it, `aud` is the default indicator, which must also be the MCP URL.

### Keycloak 26.7

Tag: **documented** (Keycloak MCP authorization server guide). The guide marks both features as experimental, and its header reads "Nightly 26.8.0", so check the flags against your 26.7 release before you rely on them.

1. Start Keycloak with the flags the guide names: `--features=cimd,resource-indicators`.
2. In the admin console, create a client profile with the `client-id-metadata-document` executor, and a client policy with the `client-id-uri` condition. Together they accept CIMD client ids.
3. Add an Audience mapper. Without resource indicators, set Included Custom Audience to the MCP URL. With resource indicators, use Included Client Audience for the MCP server client. With CIMD and the resource-indicator allow list set, the executor adds the mapper for you.
4. Point obsidian-tc at the realm:

```yaml
auth:
  mode: jwt
  resource: https://vault.example.com/mcp
  audience: https://vault.example.com/mcp
  issuer: https://keycloak.example.com/realms/<realm>
  jwksUri: https://keycloak.example.com/realms/<realm>/protocol/openid-connect/certs
  authorizationServers:
    - https://keycloak.example.com/realms/<realm>
```

ChatGPT is not supported through Keycloak's CIMD: Keycloak rejects ChatGPT's metadata document, because that document uses `token_endpoint_auth_methods_supported`, which Keycloak does not implement. Claude Code and Codex work with the Keycloak setup above, as the guide describes.

### Cloudflare Access: not yet supported

Cloudflare Access managed OAuth issues opaque `oauth:` bearer tokens and checks them at the edge. obsidian-tc verifies JWTs locally and cannot check an opaque token, so this server cannot accept Access tokens. Use the bundled server, WorkOS AuthKit or Keycloak. The Cloudflare `workers-oauth-provider` library has the same opaque-token limit.

## Sources

Vendor pages read 2026-10-11. Facts marked "research note" are not on the pages we read; they come from the research note of 2026-10-09.

- Claude connector authentication: https://claude.com/docs/connectors/building/authentication
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Codex MCP: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- ChatGPT MCP (desktop app): https://learn.chatgpt.com/docs/extend/mcp
- Gemini CLI MCP: https://geminicli.com/docs/tools/mcp-server/
- WorkOS AuthKit MCP: https://workos.com/docs/authkit/mcp
- Keycloak MCP authorization server guide: https://www.keycloak.org/securing-apps/mcp-authz-server
- VS Code MCP servers (read; no OAuth section): https://code.visualstudio.com/docs/copilot/customization/mcp-servers
