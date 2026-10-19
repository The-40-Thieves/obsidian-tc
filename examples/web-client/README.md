# Web client example

A static page that signs in to an obsidian-tc server as a public OAuth client (PKCE S256, dynamic
client registration), then runs `list_vaults`, a text search, and `read_note` on a clicked result.
There is no build step and no framework: `index.html` loads `app.mjs`, which imports the MCP client
from a pinned CDN URL (`https://esm.sh/@modelcontextprotocol/client@2.3.1`, the version that matches
the server's `@modelcontextprotocol/server` 2.3.1). `oauth.mjs` holds the PKCE, authorize-URL and
redirect-check code with no DOM, and `oauth.test.mjs` runs it under `node --test`.

## Run it

1. Enable the bundled authorization server and allow this page's origin in the server config:

   ```yaml
   auth:
     mode: jwt
     resource: http://127.0.0.1:8765/mcp
     as:
       enabled: true
       issuer: http://127.0.0.1:8765
       dynamicRegistration: true
   transports:
     http:
       enabled: true
       cors:
         allowedOrigins: ["http://localhost:8000"]
   ```

   `allowedOrigins` takes exact origins (no path, no wildcard). The AS accepts a loopback redirect
   (`http://localhost:<port>/`) from dynamic registration. See the
   [authorization server](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/src/content/docs/configuration/config-yaml.md)
   options in `configuration/config-yaml.md` (`auth.as`), and the
   [From a web page](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/src/content/docs/security/auth-model.md#from-a-web-page)
   section of the auth model for the CORS rules.

2. Serve the directory on the port you allowed. The redirect URI is the page URL, so use the same
   origin in both places:

   ```sh
   python3 -m http.server 8000 --directory examples/web-client
   # or: bunx serve examples/web-client -l 8000
   ```

3. Open `http://localhost:8000/`, keep the endpoint (`http://127.0.0.1:8765/mcp`), and click Sign in.

The page calls `/mcp` (the default `triad` facade): `list_vaults`, `search_text` and `read_note` go
through `call_capability`. If the server advertises the tools directly, the page calls them by name.
Point the MCP endpoint at `/mcp/<surface>` to use another profile.

## Tokens and sign-in

- The access and refresh tokens live in the page's memory only. The refresh token rotates through
  the authorization server. Reloading the page signs you in again.
- sessionStorage keeps the client_id (per server origin) and the pending sign-in (PKCE verifier and
  `state`) for the length of the redirect round trip. Nothing token-shaped is written to storage.
- `state` and `iss` (RFC 9207) are checked on return, and the `error` parameter is reported only
  after both pass.

## Threat model

Tokens are held in memory, so any script on this page can read them. Cross-site scripting on this
origin is token theft. Note content is rendered with `textContent` only, which keeps a note's text
from becoming markup.

## Manual browser check (not run in CI)

The pure functions are covered by `node --test`. The page itself has not been run in a browser. To
check it by hand:

1. Start the server with the config above and serve this directory on port 8000.
2. Open the page, click Sign in, and approve on the authorization server's page.
3. Confirm the vault dropdown fills from `list_vaults`, search for a word that a note contains, and
   click a result: its body should appear.
4. Reload the page: it should show the sign-in state again, not a signed-in session.
5. Open the devtools Application tab: localStorage must be empty, and sessionStorage must hold no
   token after sign-in.

## Deviations from the full flow

- Server-initiated elicitation (`elicitation/create`) renders as a JSON answer box with Accept and
  Decline. Modern-era `input_required` results are not answered: the page reports them and stops.
- The page does not use the SDK's `startAuthorization`: it builds the authorization URL itself so
  the PKCE step can be tested without a browser.
