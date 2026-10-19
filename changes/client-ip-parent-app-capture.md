---
type: Fixed
---
- **A client address survives a parent app that rebuilds the request.** An embedder that mounts the app under its own Hono app and registers a body-rebuilding middleware (such as `bodyLimit`) before the route could make a chunked `POST /oauth/login` lose its address under Bun, which skipped the per-IP login limit. The capture now keeps a peer a parent already recorded, and `captureClientPeer` is exported from the package root for embedders to register first.
