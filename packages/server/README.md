# obsidian-tc (server)

MCP server for Obsidian. Comprehensive tool surface for humans and autonomous agents.

This is the main package — published to npm as `obsidian-tc`.

See the [repo root README](../../README.md) for project overview and the
[ARCHITECTURE](../../ARCHITECTURE.md) record for the dispatch pipeline and topology.

## Status

✅ **Shipped — v1.3.6.** The full tool surface (110 tools across 28 domains, milestones
M0–M7) is implemented and released. Built on Bun + Hono with Zod 4 schemas; runs under
Node `>=24` (the test suite runs vitest under Node for `node:sqlite`).

```bash
npm install -g obsidian-tc
obsidian-tc serve --vault /path/to/vault
```
