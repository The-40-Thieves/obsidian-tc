---
type: Added
---
- **Self-hosted PaaS templates.** `deploy/paas/` adds a Coolify compose template, a Dokploy template and a CapRover one-click app, all derived from `deploy/compose.http.yml`: the published image, a volume at `/data`, the shipped HTTP config, port 8765 and a generated JWT secret. The new Self-hosted PaaS deployment page explains each one, the HTTPS requirement and how to switch to the bundled authorization server.
