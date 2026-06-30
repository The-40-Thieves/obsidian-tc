# obsidian-tc

> Obsidian Turbocharged — the comprehensive, model-agnostic, agent-ready Obsidian MCP server.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
![Status: Shipped v1.2.1](https://img.shields.io/badge/Status-Shipped_v1.2.1-success)

## What it is

obsidian-tc is a comprehensive Model Context Protocol (MCP) server for [Obsidian](https://obsidian.md), designed for both humans and autonomous agents. Multi-vault native. Pluggable embeddings. Works with local Ollama or cloud models. Every Obsidian capability worth exposing.

Three pillars:

1. **Comprehensive.** ~100 tools covering every meaningful Obsidian operation, including native Bases (`.base`) support. No existing MCP exposes the full surface.
2. **Safe by default.** JWT auth, folder ACLs, kill switch, human-in-the-loop elicit on destructive operations, idempotency keys, bulk throttling.
3. **Observable from day one.** OpenTelemetry traces, Prometheus metrics, structured event emission on every tool call.

## Status

✅ **Shipped — v1.2.1** (2026-06-26). The full implementation (milestones M0–M7) is published to npm as provenance-signed packages, with a container image at `ghcr.io/the-40-thieves/obsidian-tc:1.2.1`. The surface is **103 tools across 28 domains**. Post-1.0.2, `main` landed a security-audit remediation pass, a dependency-currency sweep (Zod 4, Biome 2, napi-rs 3, Node 24), and the agent-ergonomics + distribution feature set — all shipped in v1.2.1; see the [CHANGELOG](./CHANGELOG.md).

| Milestone | Scope | Status |
|---|---|---|
| M0 | Walking skeleton: dispatch pipeline, folder ACL, HITL elicit, migrations | ✅ Merged |
| M1 | Core vault access — 30 tools (CRUD, frontmatter, tags, links) | ✅ Merged |
| M2 | Search + embeddings — 6 tools + retrieval substrate | ✅ Merged |
| M3 | Structured formats — 23 tools (Bases, Canvas, Periodic, Attachments, Bookmarks, Workspaces) | ✅ Merged |
| M4 | Plugin bridges + companion plugin — 20 tools across 9 domains | ✅ Merged |
| M5 | Memory + capture substrate — 15 tools (capture queue, memory entities + `[[link]]` graph, workspace sessions + JSONL traces, plur read proxy) | ✅ Merged |
| M6 | Bulk + admin + URI — 7 tools | ✅ Merged |
| M7 | Harden + ship: OpenTelemetry tracing, Prometheus `/metrics`, CloudEvents spool, rate limiter, 4-platform native prebuilds, release workflow | ✅ Shipped (v1.0.2) |

This repository is public under [`The-40-Thieves`](https://github.com/The-40-Thieves), licensed Apache-2.0.

## Architecture

Polyglot monorepo:

| Package | Language | Purpose |
|---|---|---|
| `packages/server` | TypeScript (Bun) | MCP protocol layer, auth, routing, tool implementations, plugin bridges |
| `packages/plugin` | TypeScript | Companion Obsidian plugin extending Local REST API |
| `packages/native` | Rust (via napi-rs) | Perf-critical primitives: vector ops, BM25, sqlite-vec wrapper |
| `packages/shared` | TypeScript | Shared Zod schemas and types |

obsidian-tc is the **converged memory engine**: vault read/write, search, and control, *plus* folded-in retrieval intelligence (GraphRAG graph-walk via `vault_graph_search`, hybrid BM25 + vector search with RRF fusion, rerank via the inference gateway, and a `knowledge_challenge` decision red-team). This supersedes the earlier "access MCP, retrieval out of scope" framing (the 2026-06-25 single-converged-product decision; see `ARCHITECTURE.md`). The reserved "V2 ML sidecar" (and the native `kmeansAssign` / `actrDecayScore` hooks) was removed; the typed-atom MemIR substrate is a downstream engine-build phase, not this v1.x line.

## Quick start

Install, then point obsidian-tc at a JSON config — a vault `id` and `path` is the
minimum (every other field has a default):

```bash
npm install -g obsidian-tc
```

`obsidian-tc.config.json`:

```json
{
  "vaults": [{ "id": "main", "path": "/path/to/your/vault" }]
}
```

```bash
obsidian-tc ./obsidian-tc.config.json
# or set the path in the environment:
OBSIDIAN_TC_CONFIG=./obsidian-tc.config.json obsidian-tc
```

## Install in Cursor / VS Code

One-click install (launches via `npx`; after installing, set the config path to your
own obsidian-tc JSON config):

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=obsidian-tc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9ic2lkaWFuLXRjIl0sImVudiI6eyJPQlNJRElBTl9UQ19DT05GSUciOiIvQUJTT0xVVEUvUEFUSC9UTy9vYnNpZGlhbi10Yy5jb25maWcuanNvbiJ9fQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_obsidian--tc-0098FF?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22obsidian-tc%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22obsidian-tc%22%5D%2C%22env%22%3A%7B%22OBSIDIAN_TC_CONFIG%22%3A%22%2FABSOLUTE%2FPATH%2FTO%2Fobsidian-tc.config.json%22%7D%7D)

Or add it by hand. The server object is the same; only the wrapper key differs — Cursor
(`~/.cursor/mcp.json`) uses `mcpServers`, VS Code (`.vscode/mcp.json`) uses `servers`:

```json
{
  "mcpServers": {
    "obsidian-tc": {
      "command": "npx",
      "args": ["-y", "obsidian-tc"],
      "env": { "OBSIDIAN_TC_CONFIG": "/ABSOLUTE/PATH/TO/obsidian-tc.config.json" }
    }
  }
}
```

`OBSIDIAN_TC_CONFIG` is the absolute path to your obsidian-tc JSON config (vaults, ACL,
transports); it may also be passed as the first CLI argument. A prebuilt MCPB bundle
(`bun run bundle` → `dist/obsidian-tc.mcpb`) is also available for one-click install in
Claude Desktop and other MCPB hosts.

## Trademark

obsidian-tc is not affiliated with or endorsed by Obsidian.md. "Obsidian" is a trademark of Dynalist Inc. This project is an independent open-source MCP server that integrates with Obsidian.

## License

Apache License 2.0. See [LICENSE](./LICENSE).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

For security issues, see [SECURITY.md](./SECURITY.md).
