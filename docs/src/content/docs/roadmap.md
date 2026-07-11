---
title: Roadmap
description: What ships in v1.0, what is deferred to v1.1, and what is out of scope.
---

## v1.0 (current)

The complete G2.1 tool surface — 128 tools across 28 domains — plus the M7
hardening gate: conditional OpenTelemetry tracing, the Prometheus catalog and
`/metrics` endpoint, the MORGIANA CloudEvents spool, a dispatch-wide rate limiter,
a >80% coverage gate, the 8-triple native prebuild (linux/darwin/win x64+arm64,
plus linux x64+arm64 musl) + release workflow, and this documentation site.

## Deferred to v1.1

- cosign binary signing and CycloneDX SBOM generation.
- The richer `obsidian-tc serve / init / auth / …` subcommand CLI (v1.0 ships a
  config-path launcher).
- Per-tool reference pages auto-generated from the live tool registry.

## Out of scope

The converged-engine decision (2026-06-25) folded retrieval intelligence *into* obsidian-tc — GraphRAG (`vault_graph_search`; vector-seed + wikilink-expansion RRF), FTS5 BM25 text search, dense-vector search, and gateway-optional rerank all ship in the v1.x line. This **supersedes** the earlier "obsidian-tc is an access MCP; pair it with an external retrieval/RAG service" framing.

What remains out of scope for the v1.x line:

- A **general BM25 + vector hybrid retriever** — RRF over lexical *and* dense rankings for all vault search. Today RRF fuses only the GraphRAG seed/expansion streams; `search_vault` auto mode runs text, then semantic on zero hits. Tracked as THE-196.
- **Clustering and graph ML** — k-means, the removed Python ML sidecar, and ACT-R decay. The native hooks were removed.
- The **typed-atom MemIR substrate** (claim atoms, bi-temporal `authoritative_claims`) — a downstream engine-build phase (THE-235).
- **Multi-vault GraphRAG edge isolation** — `vault_edges` is single-vault today; per-vault edge scoping is a follow-up (THE-233).
