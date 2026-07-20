# obsidian-tc

**Obsidian Turbocharged** — governed, agent-ready vault access over [MCP](https://modelcontextprotocol.io) for [Obsidian](https://obsidian.md). Built for both humans and autonomous agents. Multi-vault native. Pluggable embeddings. Runs locally by default (Ollama embeddings, SQLite, no cloud account).

> **Status:** Shipped — **v1.7.0** (2026-07-12). Published to npm as provenance-signed packages, with a container image at `ghcr.io/the-40-thieves/obsidian-tc:1.7.0`, a one-click `.mcpb` bundle, and standalone binaries. The surface is **141 tools across 31 domains**, advertised by default through a three-tool facade. Licensed **AGPL-3.0-only**.

## Three pillars

1. **Broad.** 141 tools covering the meaningful Obsidian operations — native Bases (`.base`) with a real expression-DSL evaluator, Canvas, Excalidraw, deep plugin bridges, GraphRAG retrieval, a quarantined work-memory tier, and composite context calls — the broadest open-source Obsidian MCP surface we know of (surveyed 2026-07).
2. **Governed by default.** JWT auth (HS256 or asymmetric RS256/ES256/EdDSA via a local JWKS), per-vault folder ACLs, a read-only kill switch, human-in-the-loop (HITL) confirmation on destructive operations, compare-and-swap on writes, idempotency keys, and per-class rate limiting.
3. **Observable from day one.** OpenTelemetry traces, Prometheus metrics, a CloudEvents spool, and structured event emission on every tool call.

## The interface: 3 tools, 141 governed capabilities

By default `tools/list` advertises just **three meta-tools**: `find_capability` (BM25 search over the capability catalog), `describe_capability` (one capability's schema, scopes, and safety hints), and `call_capability` (invoke by name — routed through the same auth/ACL/HITL/idempotency/throttle pipeline as a direct call). This keeps agent context lean while the full surface stays reachable; `toolFacade.mode` selects `triad` (default), `domain`, or `flat`. The facade is boundary-only — no gate is ever bypassed.

Beyond Tools, the server exposes the vault as MCP **Resources** (`obsidian-tc://<vault>/<path>` URIs, read-scope and folder-ACL enforced) and built-in **Prompts**.

## The memory engine (v1.6–v1.7)

The v1.6–v1.7 line turned the server into a **measured memory engine**:

- an **experiential work-memory tier** — a quarantined second store (never mixed with authored notes) with retrieval logging, auto-captured agent episodes behind a poison scanner, and reader tools under a strict eligibility contract;
- **composite context surfaces** — `vault_context` (one-call budgeted context: graph-reranked chunks, synthesis patterns, contradictions, lesson surfacing, session bootstrap) and `reflect` (grounded synthesis, adversarial challenge, a versioned preference profile);
- **dependency-aware deletion** — `forget` with tombstone-vs-erase modes and a hash-chained audit log;
- **retrieval measured, not asserted** — an n=136 golden set with a statistical ship rule gates every ranking change; contextual chunk enrichment measured **+0.223 nDCG** and defaults on; mechanisms that lost their A/B ship dark behind flags with the numbers recorded.

## Quick start

```bash
npm install -g obsidian-tc      # Node >= 24 or Bun >= 1.1 (runtime auto-detected)
obsidian-tc /path/to/your/vault # zero-config: boots a single vault "main" with defaults
```

Pull the default local embeddings model once (`ollama pull nomic-embed-text`) and everything runs on your machine. For multi-vault, auth, ACLs, or custom embeddings, pass a JSON config file instead — see **[[Installation]]** and **[[Configuration]]**.

## Wiki map

| Page | What's in it |
|---|---|
| **[[Installation]]** | Install methods, runtimes, the companion plugin, native module |
| **[[Configuration]]** | Config schema, vaults, auth, ACL, embeddings, retrieval + experiential knobs |
| **[[Architecture]]** | Components, dispatch pipeline, IPC contracts, multi-vault registry, memory engine |
| **[[Tool Reference]]** | The domain index for all 141 tools with one-line descriptions |
| **[[Deployment Modes]]** | STDIO, HTTP local, HTTP remote, Docker, MCPB, standalone binary |
| **[[Security and ACL]]** | Scopes, HITL thresholds, kill switch, CAS, idempotency, elicit tokens |
| **[[Plugin Bridges]]** | Companion plugin, discovery probe, supported third-party plugins |
| **[[Observability]]** | OTLP traces, Prometheus metrics, CloudEvents, JSONL traces |
| **[[Contributing]]** | Dev setup, conventions, adding a tool, release process |
| **[[FAQ]]** | Common questions and gotchas |

## Architecture at a glance

Polyglot monorepo:

| Package | Language | Purpose |
|---|---|---|
| `packages/server` | TypeScript (Bun/Node) | MCP protocol layer, auth, routing, tool impls, plugin bridges |
| `packages/plugin` | TypeScript | Companion Obsidian plugin extending Local REST API |
| `packages/native` | Rust (napi-rs) | Optional acceleration: cosine similarity, tokenizer, BM25 — with a numerically identical pure-JS fallback |
| `packages/shared` | TypeScript | Shared Zod schemas and types |

## Links

- **Repository:** https://github.com/The-40-Thieves/obsidian-tc
- **npm:** `obsidian-tc`
- **Container:** `ghcr.io/the-40-thieves/obsidian-tc`
- **Docs site source:** `docs/` (Astro Starlight) — deep reference lives there and in `ARCHITECTURE.md`
- **MCP spec target:** [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)

## Trademark

obsidian-tc is not affiliated with or endorsed by Obsidian.md. "Obsidian" is a trademark of Dynalist Inc. This is an independent open-source MCP server that integrates with Obsidian.
