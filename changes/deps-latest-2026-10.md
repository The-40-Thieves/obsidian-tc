---
type: Changed
---
- **Dependencies moved to their latest releases.** `better-sqlite3` 12 to 13 (now N-API with prebuilt binaries shipped inside the package, so the install no longer needs `prebuild-install`, `node-gyp` or an install script; `@types/better-sqlite3` 9), `@modelcontextprotocol/server` 2.3.1, `hono` 4.13.13, `@hono/node-server` 2.1.3, the OpenTelemetry packages, `systeminformation`, `@redis/client` 6.3, Vitest 5.0.3, Biome 2.5.15, and the docs site's Astro 7.3.7 and Starlight 0.42.5. `@types/node` moves to 26: types target Node 26 while the runtime floor stays Node 24 (`engines.node` is unchanged). The docs site stays on TypeScript 6.0.3 because `astro check` does not support TypeScript 7 yet.
