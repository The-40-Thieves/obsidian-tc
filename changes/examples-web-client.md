---
type: Added
---
- **Browser sign-in example.** `examples/web-client/` is a static page that signs in to the bundled authorization server with PKCE, then searches a vault and reads a note. Allow its origin with `transports.http.cors.allowedOrigins`; the example README has the config.
