---
type: Added
---
- **Fly.io and VPS deploy bundles.** `fly.toml` runs the published image as one Fly Machine with a volume at `/data`, the shared HTTP config and a `/healthz` check; create it with `fly launch --from`. `deploy/cloud-init.yaml` sets up an Ubuntu 24.04 server with Docker and Caddy, writes the shared Compose file and generates the JWT secret on the server. The Fly.io and VPS deployment pages explain the first-run steps.
