<!--
  GitHub Wiki home page. Seed source for the automated wiki publisher (THE-475).
  Prose here is hand-authored; the reference sections marked GENERATED are produced by docgen (THE-472).
-->

# obsidian-tc

**A headless, agent-first semantic-knowledge server for your Obsidian vault.** It indexes your notes into a hybrid retrieval stack — dense vectors, sparse/ColBERT, BM25, and the wikilink graph — and exposes them to AI agents over the Model Context Protocol (MCP). No Obsidian plugin, no running app: it works with the vault **closed**.

<!-- Quick-start badges (replace the placeholders with your shields.io URLs) -->
[![Build](https://img.shields.io/badge/build-passing-brightgreen)](#) &nbsp;
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](#) &nbsp;
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-8A2BE2)](#) &nbsp;
[![Docs](https://img.shields.io/badge/docs-wiki-informational)](#)

> [!NOTE]
> New here? Jump to the **[Installation Guide](Installation-Guide)** to get a server running against your vault in a few minutes, then browse the **[Tool Reference](Tool-Reference)** to see what agents can do.

---

## Why obsidian-tc

Most Obsidian MCP servers are thin bridges to the Local REST API or the filesystem. obsidian-tc is a different category: it **owns its own search index, embedding store, and graph layer**, so it is independent of Obsidian's runtime and gives agents production-grade semantic retrieval over your knowledge base.

## Features

- [x] **Dense vector search** (sqlite-vec) with per-vault partitioning
- [x] **Sparse + ColBERT** multi-vector retrieval (bge-m3)
- [x] **BM25 / full-text search** (SQLite FTS5)
- [x] **Wikilink graph** + kNN / tag-cooccurrence densification
- [x] **Contextual chunk enrichment** (title + heading breadcrumb) before embedding
- [x] **Rich write surface** — `write_note`, `patch_note` (heading- & block-anchored edits), `append_note`, `update_frontmatter`, and more
- [x] **Multi-vault**, `vaultId`-scoped, with per-vault ACLs
- [x] **Runtime secret-gating** — credential-shaped chunks never reach the embedding provider
- [x] **Auth** — JWT (HS256 + JWKS), OAuth Protected-Resource Metadata
- [x] **Observability** — OpenTelemetry traces + Prometheus metrics
- [x] **Headless / Docker** deploy; stdio **and** Streamable HTTP transports

## Getting Started — roadmap

Follow these in order:

1. **[Installation Guide](Installation-Guide)** — install, configure an embedding provider, run your first index.
2. **[Configuration Reference](Configuration-Reference)** — every config key, type, and default.
3. **[Tool Reference](Tool-Reference)** — the MCP tools agents call (search, read, write, patch).
4. **[Architecture](Architecture)** — how indexing, retrieval, and the graph fit together.
5. **[Deployment & Operations](Deployment-and-Operations)** — Docker, health, metrics, backups.
6. **[Contributing](Contributing)** — dev setup, gates, and how to open a PR.

> [!TIP]
> Running agents against a large or private vault? Read **[Security & ACLs](Security-and-ACLs)** before you expose the HTTP transport beyond loopback.

---

<sub>obsidian-tc is licensed under AGPL-3.0. See the [Contributing](Contributing) guide to get involved.</sub>
