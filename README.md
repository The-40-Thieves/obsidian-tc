# obsidian-tc

> Obsidian Turbocharged — governed, agent-ready vault access over MCP.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
![Status: Shipped v1.3.6](https://img.shields.io/badge/Status-Shipped_v1.3.6-success)

```bash
npm install -g obsidian-tc      # Node >= 24 or Bun >= 1.1
```

Also ships as a Docker image (`ghcr.io/the-40-thieves/obsidian-tc`), a one-click `.mcpb` bundle, and standalone binaries.

## Why this exists

An AI agent with raw filesystem access to your Obsidian vault can do real damage: overwrite years of notes, delete the wrong folder, read the journal you never meant to expose, or quietly leak plugin API keys sitting in `.obsidian/`. Most Obsidian MCP servers hand an agent that access with little more than an API key between it and everything you have written.

obsidian-tc gives agents **governed** access instead. Every tool call — no exceptions — runs through one dispatch pipeline: auth → scopes → folder ACL → read-only kill switch → idempotency → throttle → human-in-the-loop confirmation → handler → response governor → audit log. You decide which folders an agent can read, write, or delete (per vault, per caller); destructive operations fail closed until a human approves them; and every invocation is audited.

New here? Start with the [5-minute quickstart](./docs/QUICKSTART.md) or the [threat model and design rationale](./docs/WHY.md).

## The interface: 3 tools, ~123 governed capabilities

By default the server advertises just **three meta-tools** instead of a wall of ~123:

- **`find_capability`** — BM25 search over the caller-visible capability catalog ("how do I move a note?")
- **`describe_capability`** — one capability's schema, required scopes, and safety hints
- **`call_capability`** — invoke the named capability; the call routes through the same auth/scope/ACL/HITL/idempotency/throttle pipeline as a direct call, and the target's own schema validates the arguments

This keeps agent context lean while the full surface — 123 tools across 28 domains — stays reachable, and every tool remains directly callable by name. `toolFacade.mode` selects the shape: `triad` (default), `domain` (~a dozen domain meta-tools like `notes`, `search`, `vault`), or `flat` (the full advertised surface, the pre-facade behavior). The facade is boundary-only: no gate is ever bypassed, whichever mode you pick.

## What it is

obsidian-tc is a comprehensive Model Context Protocol (MCP) server for [Obsidian](https://obsidian.md), designed for both humans and autonomous agents. Multi-vault native. Pluggable embeddings. Works with local Ollama or cloud models.

Three pillars:

1. **Broad.** 123 tools covering the meaningful Obsidian operations, including native Bases (`.base`) support with a real expression-DSL evaluator — the broadest open-source Obsidian MCP surface we know of (surveyed 2026-07).
2. **Governed by default.** JWT auth (HS256 or asymmetric RS256/ES256/EdDSA via a local JWKS with `kid` rotation), folder ACLs (per vault), read-only kill switch, human-in-the-loop elicit on destructive operations, compare-and-swap on writes, idempotency keys, bulk throttling.
3. **Observable from day one.** OpenTelemetry traces, Prometheus metrics, structured CloudEvents emission on every tool call — all opt-in export streams that fail soft.

Beyond Tools, the server exposes your vault as MCP **Resources** (`resources/list` + `resources/read` over `obsidian-tc://<vault>/<path>` URIs, read-scope and folder-ACL enforced) and a set of built-in **Prompts** (`prompts/list` + `prompts/get`).

## Status

✅ **Shipped — v1.3.6** (2026-07-03). Published to npm as provenance-signed packages, with a container image at `ghcr.io/the-40-thieves/obsidian-tc:1.3.6`. The surface is **123 tools across 28 domains**, presented by default via the triad facade described above. v1.3.x adds (see the [CHANGELOG](./CHANGELOG.md)): per-vault ACLs with the root ACL as inherited default, mandatory symlink-canonical ACL enforcement, a notes-metadata table + trigram FTS5 search substrate with index-on-write coverage across every note mutation (disk-scan fallback when FTS is unavailable), vec0 KNN vault pushdown, an Obsidian Bases expression-DSL subset evaluator with realigned view keys, compute-abuse budgets (regex worker timeout, JSONLogic op budget), a periodic cache-maintenance sweep, single-serialization dispatch, `server_health` index/`notes_ready`/`fts_enabled` reporting and config-key parity, a companion API-version floor with a bundle shape self-check, asymmetric JWT via a local JWKS, the sleep-time consolidation scheduler, and the AGPL-3.0 relicense.

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
| `packages/shared` | TypeScript | Shared Zod schemas and types |
| `packages/native` | Rust (via napi-rs) | Optional acceleration with a numerically-identical pure-JS fallback — see below |

**Where the native module actually matters:** the main native win is **cosine similarity** on the brute-force vector path (used when the bundled `sqlite-vec` extension can't load). The native tokenizer + BM25 scorer power the **fallback** lexical ranker (the exhaustive disk scan used for sub-trigram queries or when the FTS index is missing/unhealthy) and the `find_capability` catalog search — the **primary** lexical ranking for `search_text` is SQLite FTS5's own `bm25()` over the trigram `notes_fts` index. Everything works without a prebuild; the native module makes some cold paths faster.

obsidian-tc is the **converged memory engine**: vault read/write, search, and control, *plus* folded-in retrieval intelligence: GraphRAG graph-walk via `vault_graph_search` (vector seeds + wikilink expansion, fused with RRF), FTS5 BM25 text search and dense-vector search as separate retrieval modes, gateway-optional rerank, and a `knowledge_challenge` decision red-team. The RRF fuses GraphRAG's seed/expansion streams — there is no general BM25+vector hybrid retriever for vault search yet (`search_vault` auto runs text, then semantic on zero hits), tracked as THE-196; GraphRAG edges are single-vault today (THE-233). Ambient consolidation (weekly synthesis + decision audit) runs on the sleep-time plane when the inference gateway is configured; the GraphRAG ship-gate eval (recall@10 vs baseline) still requires an out-of-band run against a live embedding backend — machinery present and scheduled, headline retrieval numbers pending (THE-296). This supersedes the earlier "access MCP, retrieval out of scope" framing (the 2026-06-25 single-converged-product decision; see `ARCHITECTURE.md`). The reserved "V2 ML sidecar" (and the native `kmeansAssign` / `actrDecayScore` hooks) was removed; the typed-atom MemIR substrate is a downstream engine-build phase, not this v1.x line.

## Quick start

Full walkthrough (Claude Desktop / Claude Code wiring, first queries, a governed write): [docs/QUICKSTART.md](./docs/QUICKSTART.md).

Install, then point obsidian-tc at a JSON config — a vault `id` and `path` is the
minimum (every other field has a default):

```bash
npm install -g obsidian-tc
```

obsidian-tc runs on **Node (>= 24)** or **[Bun](https://bun.sh) (>= 1.1)** — `npm` / `npx`
installs run under Node (which uses `better-sqlite3`, falling back to the built-in
`node:sqlite`); under Bun it uses `bun:sqlite`. The runtime is auto-detected, so the same
install works either way.

The fastest start is zero-config: point it at a vault folder and it boots a single
vault named `main` with sensible defaults.

```bash
obsidian-tc /path/to/your/vault
```

For multi-vault, auth, ACLs, or custom embeddings, pass a config file instead:

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
hybrid retrieval substrate, and observability. A rough comparison of the open-source
servers (tool counts and features as of 2026-07 — these projects move; check their repos):

| | Tools | Search | Auth / ACL / HITL | Observability |
|---|---|---|---|---|
| **obsidian-tc** | ~123 (3-tool facade) | FTS5 BM25 · vector (vec0) · GraphRAG RRF | JWT (HS256/JWKS) + per-vault folder ACL + HITL elicit | OTel + Prometheus + CloudEvents |
| [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | ~14 | text / regex | JWT/OAuth + folder-scoped paths + read-only mode + HITL; MCP 2025-11-25 pagination | console logs |
| [MarkusPfundstein/mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) | ~13 | text + JsonLogic / DQL | Local REST API key | console logs |
| [StevenStavrakis/obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp) | ~11 | text | path validation, no auth layer | console logs |

Where obsidian-tc goes further: multi-vault in one process with per-vault ACLs, hybrid
lexical + vector + graph retrieval, compare-and-swap and idempotency on writes, a
per-invocation audit trail, and production observability. Where the community servers win:
footprint and simplicity — see the next section.

## When NOT to use obsidian-tc

Honest guidance — obsidian-tc is deliberately a heavier product:

- **You want the smallest possible footprint.** A single trusted human driving a chat
  client over one vault is well served by the simpler community servers above; the
  governance pipeline here mostly pays off with autonomous or multi-agent access.
- **You only need read access.** A read-only wrapper (or cyanheads' read-only mode) is
  less machinery for a similar safety outcome.
- **You want everything inside Obsidian.** obsidian-tc is a standalone server, not an
  Obsidian plugin — the optional companion plugin only bridges plugin-specific features.
  If you never leave the app, community plugins may be all you need.
- **You don't need MCP at all.** Obsidian URI or the Local REST API plugin can cover
  simple scripting directly.

Migrating the other way — replacing an existing Obsidian MCP setup with obsidian-tc —
is covered in [docs/CUTOVER.md](./docs/CUTOVER.md).

## Docs

- [docs/QUICKSTART.md](./docs/QUICKSTART.md) — install to first governed write in ~5 minutes
- [docs/WHY.md](./docs/WHY.md) — threat model, what governance means concretely, what obsidian-tc is not
- [docs/COHERENCE.md](./docs/COHERENCE.md) — writing while Obsidian is open: the coherence contract
- [docs/CUTOVER.md](./docs/CUTOVER.md) — migrating from another Obsidian MCP server
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the dispatch pipeline and package layout
- [SECURITY.md](./SECURITY.md) — threat model, protections, reporting

## Trademark

obsidian-tc is an independent, community-built open-source project. It is **not** affiliated with, endorsed by, or sponsored by Obsidian or its maker, Dynalist Inc. "Obsidian" is a trademark of Dynalist Inc.; it is used here only nominatively — to describe the application this MCP server interoperates with — including within the package, image, and plugin names (`obsidian-tc`), which denote compatibility, not origin or endorsement. For the official app, visit [obsidian.md](https://obsidian.md).

## License

GNU Affero General Public License v3.0 (AGPL-3.0-only). See [LICENSE](./LICENSE). A commercial-exception license may also be available for use that cannot meet the AGPL's network-copyleft terms — open a [discussion](https://github.com/The-40-Thieves/obsidian-tc/discussions) to enquire. Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/); see [CONTRIBUTING.md](./CONTRIBUTING.md#license-and-sign-off-dco) for how to sign off your commits.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

For security issues, see [SECURITY.md](./SECURITY.md).
