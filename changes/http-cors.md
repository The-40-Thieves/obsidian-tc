---
type: Added
---
- **Opt-in CORS for browser clients.** Set `transports.http.cors.allowedOrigins` to the exact web origins of your pages (for example `https://app.example.com`) and browsers can call the MCP endpoint, the OAuth token, registration and revocation endpoints, and the `/.well-known` metadata. The list is empty by default and then no CORS header is sent. Origins are echoed back exactly, never `*`, and no credentials are shared. See "From a web page" in the authentication docs.
