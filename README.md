# obsidian-tc

> Obsidian Turbocharged — the comprehensive, model-agnostic, agent-ready Obsidian MCP server.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
![Status: G2 Design](https://img.shields.io/badge/Status-G2_Design-orange)

## What it is

obsidian-tc is a comprehensive Model Context Protocol (MCP) server for [Obsidian](https://obsidian.md), designed for both humans and autonomous agents. Multi-vault native. Pluggable embeddings. Works with local Ollama or cloud models. Every Obsidian capability worth exposing.

Three pillars:

1. **Comprehensive.** ~100 tools covering every meaningful Obsidian operation, including native Bases (`.base`) support. No existing MCP exposes the full surface.
2. **Safe by default.** JWT auth, folder ACLs, kill switch, human-in-the-loop elicit on destructive operations, idempotency keys, bulk throttling.
3. **Observable from day one.** OpenTelemetry traces, Prometheus metrics, structured event emission on every tool call.

## Status

🔧 **In design.** G1 (Clarify) closed 2026-05-18. G2 (Design) open. Targeting v1.0 ship in Q3 2026.

This repository will be transferred to [`The-40-Thieves`](https://github.com/The-40-Thieves) once scaffolding lands.

## Architecture

Polyglot monorepo:

| Package | Language | Purpose |
|---|---|---|
| `packages/server` | TypeScript (Bun) | MCP protocol layer, auth, routing, tool implementations, plugin bridges |
| `packages/plugin` | TypeScript | Companion Obsidian plugin extending Local REST API |
| `packages/native` | Rust (via napi-rs) | Perf-critical primitives: vector ops, BM25, sqlite-vec wrapper |
| `packages/shared` | TypeScript | Shared Zod schemas and types |

V2 (post-v1.0) adds an opt-in Python ML sidecar for clustering and graph ML.

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
