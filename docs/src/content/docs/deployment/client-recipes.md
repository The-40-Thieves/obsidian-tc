---
title: Client recipes
description: Setup for each MCP client against the bundled authorization server, bring-your-own recipes for WorkOS AuthKit and Keycloak 26.7, and what is not supported yet.
---

Each recipe connects one MCP client to a server you run. The bundled authorization server is the default. WorkOS AuthKit and Keycloak are the vetted outside alternatives. The settings are explained in [Authentication](/security/auth-model/) and [Configuration](/configuration/config-yaml/).

Every client carries one tag:

- **verified**: a live sign-in was done and the steps worked.
- **documented**: the vendor's own docs describe the setup. The steps have not been run here.
- **unverified**: no vendor page we read confirms the setup. It comes from the research note only and may be wrong.

The **Last live check** column records the date of the latest live run. The verified rows below were checked with a live sign-in on 2026-10-12, followed by a successful vault tool call. None used DCR.

Server side, for every client on the bundled server: `auth.mode: jwt`, `auth.as.enabled: true`, `auth.resource` set to the MCP URL, and `auth.as.issuer` set to the server's origin. Dynamic Client Registration is on by default (`auth.as.dynamicRegistration`). A client that uses only a metadata document does not need it.

## Bundled authorization server

### Tier 1: metadata document or DCR

| Client | Tag | Registration | Last live check |
| --- | --- | --- | --- |
| Claude Code | verified | Metadata document `https://claude.ai/oauth/claude-code-client-metadata`; loopback redirect `http://localhost/callback` on any port | 2026-10-12 |
| Claude Code (`/mcp/essentials`) | verified | Same metadata document and loopback redirect as the default profile | 2026-10-12 |
| claude.ai custom connector (including Claude Desktop) | verified | Metadata document `https://claude.ai/oauth/mcp-oauth-client-metadata`; redirect `https://claude.ai/api/mcp/auth_callback` | 2026-10-12 |
| ChatGPT (Plugins) | verified | Metadata document `https://chatgpt.com/oauth/client.json`; redirect `https://chatgpt.com/connector_platform_oauth_redirect` | 2026-10-12 |
| Codex CLI | verified | Metadata document `https://chatgpt.com/oauth/codex/client.json`; redirect `http://127.0.0.1/callback` | 2026-10-12 |
| Antigravity (Windows desktop) | verified | Metadata document `https://antigravity.google/oauth/client-metadata.json`; redirect `https://antigravity.google/oauth-callback` | 2026-10-12 |

#### Claude Code

```bash
claude mcp add --transport http <name> https://vault.example.com/mcp
claude mcp login <name>
```

Inside Claude Code, `/mcp` starts the same browser sign-in. If a server needs an exact redirect port, add `--callback-port <port>`.

The same flow worked against `/mcp/essentials`. Claude Code used its metadata document and a loopback callback on a dynamically selected port; it did not use DCR.

#### claude.ai custom connector

Add a custom connector with the MCP URL and sign in. The connector uses `https://claude.ai/oauth/mcp-oauth-client-metadata` as its client id and redirects to `https://claude.ai/api/mcp/auth_callback`; it does not use DCR. The metadata-document flow completed without stalling after metadata was fetched. The same connector worked from Claude Desktop.

#### ChatGPT (Plugins)

There is no separate developer-mode toggle.

1. Open `chatgpt.com/plugins`, select the plus button, then select **Add custom MCP server**.
2. Enter a name and description. Under **Connection**, enter the MCP URL including `/mcp`.
3. Set **Authentication** to OAuth, accept **I understand and want to continue**, then select **Create as a plugin**.
4. Sign in and approve access.

The plugin uses `https://chatgpt.com/oauth/client.json` as its client id and redirects to `https://chatgpt.com/connector_platform_oauth_redirect`; it does not use DCR. After a server-side change, use the plugin's **Refresh** action to re-read metadata. One plugin is available in `chatgpt.com`, the ChatGPT desktop app and the desktop app's Codex view as `@<plugin>`.

#### Codex

```bash
codex mcp add <name> --url https://vault.example.com/mcp
codex mcp login <name>
codex mcp login <name> --oauth-client-registration cimd
codex mcp login <name> --oauth-client-registration dcr
```

Codex uses `https://chatgpt.com/oauth/codex/client.json` as its client id and redirects to `http://127.0.0.1/callback`; it does not use DCR. The default registration mode is `auto`: a metadata document when the server advertises one and the callback is loopback, otherwise DCR. `codex mcp add ... --oauth-client-id <id>` uses a pre-registered client and skips registration; add that client under `auth.as.clients`.

In the ChatGPT desktop app, open **Settings**, select **MCP servers**, then **Add server**. Choose **Streamable HTTP**, enter the MCP URL, leave the bearer-token and header fields empty, restart, then select **Authenticate**. OAuth is the default when those fields are empty. The desktop app, CLI and IDE extension share `~/.codex/config.toml`. Servers configured there are available to Codex sessions in those surfaces, but not to ordinary ChatGPT chats.

#### Antigravity

In the Antigravity desktop app on Windows, open its MCP settings and add the MCP URL, then sign in. Antigravity uses `https://antigravity.google/oauth/client-metadata.json` as its client id and redirects to `https://antigravity.google/oauth-callback`; it does not use DCR.

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
| Gemini CLI | unverified | DCR; the vendor page does not mention a metadata document | |
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

Tag: **verified**. Claude Code and the claude.ai custom connector, also used from Claude Desktop, each completed a live sign-in on 2026-10-12 and ran a read tool successfully. Do not enable `auth.as`: the bundled server is refused under `oidc`.

1. Create the default resource indicator through the API. It returns `201`:

   ```bash
   curl -X POST https://api.workos.com/user_management/authkit_oauth_resources \
     -H "Authorization: Bearer $WORKOS_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"uri":"https://vault.example.com/mcp","default":true}'
   ```

   The default applies to clients that omit `resource`, and only to metadata-document or DCR clients. A wildcard indicator cannot be the default. Changing the default later is dashboard-only (Set as default). Without a default indicator, `aud` is the environment's client id, and obsidian-tc refuses that token.
2. In the dashboard, under Connect and then Configuration, turn on Client ID Metadata Documents (CIMD). It is off by default. Dynamic Client Registration (DCR) is also dashboard-only: turn it on only for a client that needs it. To read the state from outside, AuthKit's `/.well-known/oauth-authorization-server` has no `registration_endpoint` while DCR is off. Its `token_endpoint_auth_methods_supported` lists `none`, `client_secret_post` and `client_secret_basic`.
3. AuthKit Connect access tokens carry `org_id`, but no `role` or `permissions` claim, even when the organization member has a role. Map the organization id to the scopes its members receive. The example grants read access only; add `write:*` deliberately if every member of that organization should write. Per-role scopes require a WorkOS API lookup, which obsidian-tc does not perform.
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
       "oidc": {
         "issuer": "https://<authkit-domain>",
         "jwksUri": "https://<authkit-domain>/oauth2/jwks",
         "audience": "https://vault.example.com/mcp",
         "claimMapping": {
           "subject": "sub",
           "scopes": "org_id",
           "scopeMap": {
             "<organization id>": ["read:*"]
           }
         }
       }
     }
   }
   ```

   `issuer` is the AuthKit domain origin, with no trailing slash, exactly as `/.well-known/oauth-authorization-server` states it. `jwksUri` is `https://<authkit-domain>/oauth2/jwks`. `audience` and `resource` are both the MCP URL. `oidc` mode runs discovery at boot and checks the issuer exactly, and it refuses to boot if discovery fails. Do not set `auth.scopesSupported` to obsidian-tc scopes for this recipe: Claude Code requests the scopes advertised there, and AuthKit refuses them with `invalid_scope`.
5. Check Protected Resource Metadata at the path-suffixed URL, which is where obsidian-tc serves it:

   ```bash
   curl https://vault.example.com/.well-known/oauth-protected-resource/mcp
   ```

   Its `authorization_servers` names the AuthKit issuer.
6. After changing `claimMapping`, clear any stored client authentication and sign in again. A token issued before `org_id` was present cannot gain the new mapping; choose the organization during the new sign-in.

With CIMD enabled in the AuthKit dashboard, Claude Code and the claude.ai connector signed in without their loopback or claude.ai redirect URIs being listed in advance. ChatGPT was not tested against AuthKit.

### Keycloak 26.7

Tag: **documented** (Keycloak MCP authorization server guide). Measured against Keycloak 26.7.4: a token issued by the realm got `initialize` 200 and `tools/list` 200, and a request with no token got 401 with `resource_metadata`. The guide marks both features as experimental, and its header reads "Nightly 26.8.0", so check the flags against your release.

Known issue, observed 2026-10-12: with `--features=cimd,resource-indicators` and the client profile and policy below, Keycloak refused an authorization request whose `client_id` was a metadata-document URL with `client_not_found`. This happened for Claude Code and a VS Code client id; the client-policy executor did not run. Until that is resolved, the metadata-document path is not usable on this release. This is under investigation; no workaround is documented here.

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
5. CIMD: as the guide describes, create a client profile with the `client-id-metadata-document` executor, and a client policy with the `client-id-uri` condition (`uri-scheme` https, `trusted-domains`). List each client's CIMD host in `trusted-domains`: `claude.ai` for Claude Code, `chatgpt.com` for Codex, `vscode.dev` and `zed.dev`. Set `resource-indicator-allow-list` to the MCP URL. On 26.7.4 this configuration still hit the known issue above before the executor ran.
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

   The token's `scope` claim carries `read:notes write:notes` when a client asks for them. Both names are scopes the server checks, so no `scopeMap` is needed. The metadata-document login remains blocked by the known issue above.

### Cloudflare Access: not yet supported

Cloudflare Access managed OAuth issues opaque `oauth:` bearer tokens and checks them at the edge. obsidian-tc verifies JWTs locally and cannot check an opaque token, so this server cannot accept Access tokens. Use the bundled server, WorkOS AuthKit or Keycloak. The Cloudflare `workers-oauth-provider` library has the same opaque-token limit.

## Sources

Vendor pages and live results used for this update were checked on 2026-10-12. Facts marked "research note" are not on the pages we read; they come from the research note of 2026-10-09.

- Claude connector authentication: https://claude.com/docs/connectors/building/authentication
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Codex MCP: https://developers.openai.com/codex/mcp
- ChatGPT Plugins: https://developers.openai.com/plugins/deploy/connect-chatgpt
- Gemini CLI MCP: https://geminicli.com/docs/tools/mcp-server/
- WorkOS AuthKit MCP: https://workos.com/docs/authkit/mcp
- WorkOS AuthKit Connect token claims: https://workos.com/docs/authkit/connect/token-claims
- Keycloak MCP authorization server guide: https://www.keycloak.org/securing-apps/mcp-authz-server
- VS Code MCP servers (read; no OAuth section): https://code.visualstudio.com/docs/copilot/customization/mcp-servers
