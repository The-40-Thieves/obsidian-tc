---
type: Deprecated
---
- **`toolFacade.mode: "auto"` is deprecated and now resolves to `triad` for every client.** The built-in table used to send Claude Code to `domain`, which the measurement above contradicts. The value is still accepted, so no config breaks, and an `autoClients` entry you wrote still takes effect. `obsidian-tc doctor` now warns about `auto`, `server_health`'s `toolFacade` block carries a `deprecation` notice, and the config schema description says so. Set an explicit `toolFacade.mode` instead (recommended: `triad`); `auto`, `autoClients` and `explainAutoMode` will be removed in the next major version.
