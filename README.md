# obsidian-tc

> Obsidian Turbocharged — the comprehensive, model-agnostic, agent-ready Obsidian MCP server.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
![Status: Shipped v1.2.1](https://img.shields.io/badge/Status-Shipped_v1.2.1-success)

## What it is

obsidian-tc is a comprehensive Model Context Protocol (MCP) server for [Obsidian](https://obsidian.md), designed for both humans and autonomous agents. Multi-vault native. Pluggable embeddings. Works with local Ollama or cloud models. Every Obsidian capability worth exposing.

Three pillars:

1. **Comprehensive.** ~100 tools covering every meaningful Obsidian operation, including native Bases (`.base`) support. No existing MCP exposes the full surface.
2. **Safe by default.** JWT auth, folder ACLs, kill switch, human-in-the-loop elicit on destructive operations, idempotency keys, bulk throttling.
3. **Observable from day one.** OpenTelemetry traces, Prometheus metrics, structured event emission on every tool call.

Beyond Tools, the server exposes your vault as MCP **Resources** (`resources/list` + `resources/read` over `obsidian-tc://<vault>/<path>` URIs, read-scope and folder-ACL enforced) and a set of built-in **Prompts** (`prompts/list` + `prompts/get`).

## Status

✅ **Shipped — v1.2.1** (2026-06-26). The full implementation (milestones M0–M7) is published to npm as provenance-signed packages, with a container image at `ghcr.io/the-40-thieves/obsidian-tc:1.2.1`. The surface is **103 tools across 28 domains**, presented by default via a compact tool-surface facade (three meta-tools — `find_capability` / `describe_capability` / `call_capability` — for progressive discovery; `toolFacade.mode: flat` advertises the full surface, and every tool stays callable by name). Post-1.0.2, `main` landed a security-audit remediation pass, a dependency-currency sweep (Zod 4, Biome 2, napi-rs 3, Node 24), and the agent-ergonomics + distribution feature set — all shipped in v1.2.1; see the [CHANGELOG](./CHANGELOG.md).

| Milestone | Scope | Status |
|---|---|---|
| M0 | Walking skeleton: dispatch pipeline, folder ACL, HITL elicit, migrations | ✅ Merged |
| M1 | Core vault access — 30 tools (CRUD, frontmatter, tags, links) | ✅ Merged |
| M2 | Search + embeddings — 6 tools + retrieval substrate | ✅ Merged |
| M3 | Structured formats — 23 tools (Bases, Canvas, Periodic, Attachments, Bookmarks, Workspaces) | ✅ Merged |
| M4 | Plugin bridges + companion plugin — 20 tools across 9 domains | ✅ Merged |
| M5 | Memory + capture substrate — 15 tools (capture queue, memory entities + `[[link]]` graph, workspace sessions + JSONL traces, plur read proxy) | ✅ Merged |
| M6 | Bulk + admin + URI — 7 tools | ✅ Merged |
| M7 | Harden + ship: OpenTelemetry tracing, Prometheus `/metrics`, CloudEvents spool, rate limiter, 8-triple native prebuilds, release workflow | ✅ Shipped (v1.0.2) |

This repository is public under [`The-40-Thieves`](https://github.com/The-40-Thieves), licensed AGPL-3.0-only.

## Architecture

Polyglot monorepo:

| Package | Language | Purpose |
|---|---|---|
| `packages/server` | TypeScript (Bun) | MCP protocol layer, auth, routing, tool implementations, plugin bridges |
| `packages/plugin` | TypeScript | Companion Obsidian plugin extending Local REST API |
| `packages/native` | Rust (via napi-rs) | Perf-critical primitives: cosine similarity, tokenization, BM25 scoring (numerically-identical pure-JS fallback when no prebuild) |
| `packages/shared` | TypeScript | Shared Zod schemas and types |

obsidian-tc is the **converged memory engine**: vault read/write, search, and control, *plus* folded-in retrieval intelligence (GraphRAG graph-walk via `vault_graph_search`, hybrid BM25 + vector search with RRF fusion, rerank via the inference gateway, and a `knowledge_challenge` decision red-team). Ambient consolidation (weekly synthesis + decision audit) runs on the sleep-time plane when the inference gateway is configured; the GraphRAG ship-gate eval (recall@10 vs baseline) still requires an out-of-band run against a live embedding backend — machinery present and scheduled, headline retrieval numbers pending (THE-296). This supersedes the earlier "access MCP, retrieval out of scope" framing (the 2026-06-25 single-converged-product decision; see `ARCHITECTURE.md`). The reserved "V2 ML sidecar" (and the native `kmeansAssign` / `actrDecayScore` hooks) was removed; the typed-atom MemIR substrate is a downstream engine-build phase, not this v1.x line.

## Quick start

Install, then point obsidian-tc at a JSON config — a vault `id` and `path` is the
minimum (every other field has a default):

```bash
npm install -g obsidian-tc
```

obsidian-tc runs on **Node (>= 24)** or **[Bun](https://bun.sh) (>= 1.1)** — `npm` / `npx`
installs run under Node (which uses `better-sqlite3`); under Bun it uses `bun:sqlite`. The
runtime is auto-detected, so the same install works either way.

The fastest start is zero-config: point it at a vault folder and it boots a single
vault named `main` with sensible defaults.

```bash
obsidian-tc /path/to/your/vault
```

For multi-vault, auth, ACLs, or custom embeddings, pass a config file instead. A
vault `id` and `path` is the minimum (every other field has a default):

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

# inspect the effective config (secrets redacted), or print the version:
obsidian-tc config show ./obsidian-tc.config.json
obsidian-tc version

# install the companion Obsidian plugin into your vault (then enable it in Obsidian):
obsidian-tc plugin install --vault /path/to/your/vault
```

### Runs locally by default

No cloud account or API key is required. With the defaults, everything runs on your
machine: embeddings via a local [Ollama](https://ollama.com) model (`nomic-embed-text`,
768-dim), vector search via the bundled `sqlite-vec` (with a pure-JS cosine fallback), and
a per-vault SQLite cache. Pull the model once, then start:

```bash
ollama pull nomic-embed-text       # the default embeddings model
obsidian-tc /path/to/your/vault    # boots local-only, no config file
```

The optional inference gateway (`OBSIDIAN_TC_GATEWAY_URL`) powers rerank and the
`knowledge_challenge` red-team; leave it unset and those degrade gracefully while
everything else keeps working. Cloud embedding providers (OpenAI, Voyage, Cohere) are
opt-in via a config file.

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

## How it compares

Most Obsidian MCP servers are thin access wrappers over the Local REST API. obsidian-tc is
a server-grade product: a centralized dispatch pipeline (auth -> scopes -> folder ACL ->
read-only -> idempotency -> throttle -> HITL -> handler -> response governor -> audit), a
hybrid retrieval substrate, and observability. A rough comparison of the open-source servers
(tool counts as of 2026-06):

| | Tools | Search | Auth / ACL / HITL | Observability |
|---|---|---|---|---|
| **obsidian-tc** | ~103 | BM25 + vector + RRF + graph | JWT + folder ACL + HITL elicit | OTel + Prometheus + CloudEvents |
| [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | ~8 | text / regex | JWT/OAuth, no folder ACL/HITL | console logs |
| [MarkusPfundstein/mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) | ~13 | text + JsonLogic / DQL | Local REST API key only | console logs |
| [StevenStavrakis/obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp) | ~11 | text | path validation, no auth | console logs |

Want the smallest footprint? The community servers are simpler. Want folder-scoped ACLs,
human-in-the-loop on destructive ops, hybrid retrieval, and multi-vault? That is what
obsidian-tc is for.

## Trademark

obsidian-tc is not affiliated with or endorsed by Obsidian.md. "Obsidian" is a trademark of Dynalist Inc. This project is an independent open-source MCP server that integrates with Obsidian.

## License

GNU Affero General Public License v3.0 (AGPL-3.0-only). See [LICENSE](./LICENSE). A commercial-exception license may also be available for use that cannot meet the AGPL's network-copyleft terms — open a [discussion](https://github.com/The-40-Thieves/obsidian-tc/discussions) to enquire. Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/); see [CONTRIBUTING.md](./CONTRIBUTING.md#license-and-sign-off-dco) for how to sign off your commits.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

For security issues, see [SECURITY.md](./SECURITY.md).
