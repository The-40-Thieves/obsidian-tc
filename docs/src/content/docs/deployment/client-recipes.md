---
title: Client recipes
description: Setup for each MCP client against the bundled authorization server, bring-your-own recipes for WorkOS AuthKit and Keycloak 26.7, and what is not supported yet.
---

Each recipe connects one MCP client to a server you run. The bundled authorization server is the default. WorkOS AuthKit and Keycloak are the vetted outside alternatives. The settings are explained in [Authentication](/security/auth-model/) and [Configuration](/configuration/config-yaml/).

**No client sign-in on this page has been run live yet.** Every client carries one tag:

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

Tag: **documented** (WorkOS AuthKit MCP guide). The settings below were measured on 2026-10-11 against a WorkOS staging environment. The organization roles and the scope mapping are **documented, pending live login**: no sign-in through AuthKit has been run yet. Do not enable `auth.as`: the bundled server is refused under `oidc`.

1. Create the default resource indicator through the API. It returns `201`:

   ```bash
   curl -X POST https://api.workos.com/user_management/authkit_oauth_resources \
     -H "Authorization: Bearer $WORKOS_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"uri":"https://vault.example.com/mcp","default":true}'
   ```

   The default applies to clients that omit `resource`, and only to metadata-document or DCR clients. A wildcard indicator cannot be the default. Changing the default later is dashboard-only (Set as default). Without a default indicator, `aud` is the environment's client id, and obsidian-tc refuses that token.
2. In the dashboard, under Connect and then Configuration, turn on Client ID Metadata Documents (CIMD). It is off by default. Dynamic Client Registration (DCR) is also dashboard-only: turn it on only for a client that needs it. To read the state from outside, AuthKit's `/.well-known/oauth-authorization-server` has no `registration_endpoint` while DCR is off. Its `token_endpoint_auth_methods_supported` lists `none`, `client_secret_post` and `client_secret_basic`.
3. Scopes come from an organization role. AuthKit's own `scopes_supported` are `email`, `offline_access`, `openid` and `profile`. Its access tokens carry `iss aud client_id sub org_id sid jti exp iat` and no `scope` claim. The `role` claim appears only for a member of an organization with a role. So put users in an organization with a role, and let `scopeMap` turn each role into obsidian-tc scopes. A bare role name grants nothing unless it is mapped. Documented, pending live login.
4. Point obsidian-tc at AuthKit:

   ```json
   {
     "cacheDir": "/var/lib/obsidian-tc/cache",
     "vaults": [{ "id": "main", "path": "/absolute/path/to/vault" }],
     "transports": { "http": { "allowedHosts": ["vault.example.com"] } },
     "auth": {
       "mode": "oidc",
       "resource": "https://vault.example.com/mcp",
       "authorizationServers": ["https://<authkit-domain>"],
       "requireJti": true,
       "scopesSupported": ["read:*", "write:*"],
       "oidc": {
         "issuer": "https://<authkit-domain>",
         "jwksUri": "https://<authkit-domain>/oauth2/jwks",
         "audience": "https://vault.example.com/mcp",
         "claimMapping": {
           "subject": "sub",
           "scopes": "role",
           "scopeMap": {
             "member": ["read:*"],
             "admin": ["read:*", "write:*"]
           }
         }
       }
     }
   }
   ```

   `issuer` is the AuthKit domain origin, with no trailing slash, exactly as `/.well-known/oauth-authorization-server` states it. `jwksUri` is `https://<authkit-domain>/oauth2/jwks`. `audience` and `resource` are both the MCP URL. `oidc` mode runs discovery at boot and checks the issuer exactly, and it refuses to boot if discovery fails. The role names `member` and `admin` are examples: use the roles your organization defines.
5. Check Protected Resource Metadata at the path-suffixed URL, which is where obsidian-tc serves it:

   ```bash
   curl https://vault.example.com/.well-known/oauth-protected-resource/mcp
   ```

   Its `authorization_servers` names the AuthKit issuer.

Whether AuthKit needs the claude.ai, ChatGPT or loopback redirect URIs listed in advance is **unverified**. Check it on the first live login.

### Keycloak 26.7

Tag: **documented** (Keycloak MCP authorization server guide). Measured 2026-10-11 against Keycloak 26.7.4: a token issued by the realm got `initialize` 200 and `tools/list` 200, and a request with no token got 401 with `resource_metadata`. No client sign-in (Claude Code, Codex) has been run, so the tag stays documented. The guide marks both features as experimental, and its header reads "Nightly 26.8.0", so check the flags against your release.

1. Start Keycloak with the features the guide names, behind a TLS-terminating proxy:

   ```bash
   KC_HOSTNAME=https://keycloak.example.com \
   KC_PROXY_HEADERS=xforwarded \
   KC_HTTP_ENABLED=true \
   kc.sh start --features=cimd,resource-indicators
   ```

2. Create the client scopes `read:notes` and `write:notes` as realm default-optional, so a client has to ask for them.
3. Add an audience mapper (`oidc-audience-mapper`) to the client scope that carries them: Included Custom Audience is the MCP URL, and Add to access token is on. With CIMD and the resource-indicator allow list set, the executor adds the mapper for you.
4. Anonymous DCR: in the Trusted Hosts policy, keep the sending-host match off and the client-URI match on. Keycloak refuses both off.
5. CIMD: create a client profile with the `client-id-metadata-document` executor, and a client policy with the `client-id-uri` condition (`uri-scheme` https, `trusted-domains`). Together they accept CIMD client ids. List each client's CIMD host in `trusted-domains`: `claude.ai` for Claude Code, `chatgpt.com` for Codex, `vscode.dev` and `zed.dev`. Set `resource-indicator-allow-list` to the MCP URL.
6. Point obsidian-tc at the realm:

   ```json
   {
     "cacheDir": "/var/lib/obsidian-tc/cache",
     "vaults": [{ "id": "main", "path": "/absolute/path/to/vault" }],
     "transports": { "http": { "allowedHosts": ["vault.example.com"] } },
     "auth": {
       "mode": "oidc",
       "resource": "https://vault.example.com/mcp",
       "requireJti": true,
       "scopesSupported": ["read:notes", "write:notes"],
       "oidc": {
         "issuer": "https://keycloak.example.com/realms/<realm>",
         "jwksUri": "https://keycloak.example.com/realms/<realm>/protocol/openid-connect/certs",
         "audience": "https://vault.example.com/mcp",
         "claimMapping": { "subject": "sub", "scopes": "scope" }
       }
     }
   }
   ```

   The token's `scope` claim carries `read:notes write:notes` when a client asks for them. Both names are scopes the server checks, so no `scopeMap` is needed. Documented, pending live login.

ChatGPT (developer mode) is not supported through Keycloak's CIMD. The research note says Keycloak rejects ChatGPT's metadata document, because that document uses `token_endpoint_auth_methods_supported`, which Keycloak does not implement. Codex is listed above under `chatgpt.com`, as the guide describes.

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
