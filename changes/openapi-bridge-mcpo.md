---
type: Added
---
- **OpenAPI clients can reach the server through an mcpo bridge.** `deploy/compose.mcpo.yml` is an overlay on the HTTP Compose bundle that runs the pinned mcpo image against the `essentials` tool profile, bound to loopback, with a shared bridge API key. Every OpenAPI caller shares one token's identity, so mint a read-only token for it. The new "OpenAPI clients (mcpo bridge)" page covers the deploy order, the Open WebUI setup and the limits.
