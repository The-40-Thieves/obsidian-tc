# obsidian-tc

> Obsidian Turbocharged — the comprehensive, model-agnostic, agent-ready Obsidian MCP server.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
![Status: G4 Implement](https://img.shields.io/badge/Status-G4_Implement_M0--M5-yellow)

## What it is

obsidian-tc is a comprehensive Model Context Protocol (MCP) server for [Obsidian](https://obsidian.md), designed for both humans and autonomous agents. Multi-vault native. Pluggable embeddings. Works with local Ollama or cloud models. Every Obsidian capability worth exposing.

Three pillars:

1. **Comprehensive.** ~100 tools covering every meaningful Obsidian operation, including native Bases (`.base`) support. No existing MCP exposes the full surface.
2. **Safe by default.** JWT auth, folder ACLs, kill switch, human-in-the-loop elicit on destructive operations, idempotency keys, bulk throttling.
3. **Observable from day one.** OpenTelemetry traces, Prometheus metrics, structured event emission on every tool call.

## Status

🚧 **In active implementation (G4).** G1 (Clarify), G2 (Design — 5 sub-docs), and G3 (Simplicity Check) are closed. G4 (Implement) is underway across 8 milestones (M0–M7); **M0–M5 are merged to `main`.** Targeting v1.0 ship in Q3 2026.

| Milestone | Scope | Status |
|---|---|---|
| M0 | Walking skeleton: dispatch pipeline, folder ACL, HITL elicit, migrations | ✅ Merged |
| M1 | Core vault access — 30 tools (CRUD, frontmatter, tags, links) | ✅ Merged |
| M2 | Search + embeddings — 6 tools + retrieval substrate | ✅ Merged |
| M3 | Structured formats — 23 tools (Bases, Canvas, Periodic, Attachments, Bookmarks, Workspaces) | ✅ Merged |
| M4 | Plugin bridges + companion plugin — 20 tools across 9 domains | ✅ Merged |
| M5 | Memory + capture substrate — 15 tools (capture queue, memory entities + `[[link]]` graph, workspace sessions + JSONL traces, plur read proxy) | ✅ Merged |
| M6 | Bulk + admin + URI — 7 tools | ⏳ Next |
| M7 | Harden + ship v1.0 | ⏳ Planned |

This repository will be transferred to [`The-40-Thieves`](https://github.com/The-40-Thieves) at the v1.0 public launch.

## Architecture

Polyglot monorepo:

| Package | Language | Purpose |
|---|---|---|
| `packages/server` | TypeScript (Bun) | MCP protocol layer, auth, routing, tool implementations, plugin bridges |
| `packages/plugin` | TypeScript | Companion Obsidian plugin extending Local REST API |
| `packages/native` | Rust (via napi-rs) | Perf-critical primitives: vector ops, BM25, sqlite-vec wrapper |
| `packages/shared` | TypeScript | Shared Zod schemas and types |

obsidian-tc is an **access** MCP: vault read/write, search, and control. Retrieval intelligence (clustering, graph ML, hybrid retrieval fusion) is out of scope; pair obsidian-tc with an external retrieval/RAG service for ranking and reasoning. An earlier reserved "V2 ML sidecar" (and the native `kmeansAssign` / `actrDecayScore` hooks) is deprecated and being removed.

## Quick start

```bash
# Not yet available — v1.0 ships Q3 2026.

# When ready:
npm install obsidian-tc
obsidian-tc serve --vault /path/to/vault
```

## Trademark

obsidian-tc is not affiliated with or endorsed by Obsidian.md. "Obsidian" is a trademark of Dynalist Inc. This project is an independent open-source MCP server that integrates with Obsidian.

## License

Apache License 2.0. See [LICENSE](./LICENSE).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

For security issues, see [SECURITY.md](./SECURITY.md).
