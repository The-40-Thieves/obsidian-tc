---
title: How obsidian-tc compares
description: The full comparison against other Obsidian MCP servers — retrieval, governance, and memory engine columns, where the others plainly win, and when NOT to use obsidian-tc.
---

The ecosystem splits into three groups, and most projects sit squarely in one:

1. **Vault access servers** — expose your vault to an agent as tools. The large majority.
2. **Retrieval engines** — the vault as a search corpus: embeddings, BM25, graph, rerank.
3. **Memory engines** — durable agent memory (what happened, what was learned, what is
   no longer true), usually in a knowledge base *beside* your vault rather than in it.

obsidian-tc is the only one we know of that is all three at once, and the combination is
the point: the memory lives **in the vault**, under the same ACL and audit pipeline as
every other write. Concretely, we are not aware of another Obsidian MCP server that pairs
**write governance** (compare-and-swap, idempotency keys, snapshots with restore, a
per-invocation audit trail) with a **memory engine** (episodes, activation decay, explicit
forgetting with a hash-chained log, contradiction detection).

That is a narrow claim, deliberately. Several of the projects below do specific things as
well as or better than we do, and the honest comparison says so.

Features as of **2026-09-03**; these projects move quickly, so check their repos rather
than trusting this table. Tool counts are omitted where a project's README and its code
disagree.

| | Tools | Group | Retrieval | Governance | Memory engine |
|---|---|---|---|---|---|
| **obsidian-tc** | 163 (3-tool facade) | all three | BM25 (FTS5) · vector (vec0) · graph · RRF fusion · diversity | JWT (HS256/JWKS) · per-vault folder ACL · HITL elicit · CAS · idempotency · snapshots · audit log | episodes · activation · forgetting · contradictions |
| [coddingtonbear/obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) (built-in MCP, v5.0+) | 18 | access | text (`search_query`/`search_simple`) | single REST API bearer key (full vault admin) | — |
| [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | ~14 | access | text / regex | JWT/OAuth · folder-scoped path policy · read-only mode · elicited delete confirmation showing blast radius | — |
| [aaronsb/obsidian-mcp-plugin](https://github.com/aaronsb/obsidian-mcp-plugin) | 8 families | access | text · graph traversal · Dataview/Bases | path allow/block lists · read-only mode · per-operation controls · API key | — |
| [bitbonsai/mcpvault](https://github.com/bitbonsai/mcpvault) | ~14 | access | BM25 | traversal + symlink protection · delete confirmation | — |
| [MarkusPfundstein/mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) | ~13 | access | text · JsonLogic / DQL | Local REST API key | — |
| [jacksteamdev/obsidian-mcp-tools](https://github.com/jacksteamdev/obsidian-mcp-tools) — **archived** (last push 2026-05-13) | — | access | DQL · JsonLogic · semantic (via Smart Connections) | Local REST API key | — |
| [engraph](https://github.com/devwhodevs/engraph) | — | retrieval | 5-lane RRF: semantic · BM25 · graph · cross-encoder rerank · temporal, fully local | API keys with read/write levels · rate limit · operation log | — |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | ~35 | memory | semantic + keyword | path containment | entities · observations · relations, in a separate markdown KB |

Where the others win, plainly:

- **Zero-config start.** `mcpvault` is one `npx` line and `engraph` is one `brew install`
  with local models bundled — no config file, no separate embeddings pull. obsidian-tc's
  `npx obsidian-tc /path/to/vault` matches that for a single vault (lexical search and every
  note tool work immediately); multi-vault, ACLs, and custom embeddings still want a config
  file, and semantic/graph retrieval still wants an embeddings backend.
- **Nothing outside Obsidian.** `aaronsb/obsidian-mcp-plugin` runs *inside* the app — no
  external process at all. obsidian-tc is a standalone server.
- **Offline retrieval quality, as core rather than opt-in.** `engraph` ships cross-encoder
  reranking and a query orchestrator as core, on local models, everywhere it runs. obsidian-tc's
  cross-encoder reranker is now also local and gateway-free — an optional npm package
  (`@the-40-thieves/obsidian-tc-reranker-local`), auto-selected when no `reranker` block, no
  `embeddings.modelTier.full`, and no gateway URL are configured, that fetches and
  checksum-verifies its weights on first use — but it is opt-in machinery, not core: the
  standalone compiled binaries, musl (Alpine) installs, and macOS x64 can't reach it.
- **Memory as a portable KB.** `basic-memory` keeps memory in its own markdown store that
  syncs to any vault. If you want memory decoupled from one vault, that is the better fit.

What we have not seen elsewhere: multi-vault in one process with per-vault ACLs, a
retrieval change gated by a paired permutation test before it ships, and the memory tier
above.

## When NOT to use obsidian-tc

Honest guidance — obsidian-tc is deliberately a heavier product:

- **You want the smallest possible footprint.** A single trusted human driving a chat
  client over one vault is well served by the simpler community servers above; the
  governance pipeline here mostly pays off with autonomous or multi-agent access.
- **You only need read access.** A read-only wrapper (cyanheads' `OBSIDIAN_READ_ONLY`, or
  aaronsb's read-only mode) is less machinery for a similar safety outcome.
- **You want everything inside Obsidian.** obsidian-tc is a standalone server, not an
  Obsidian plugin — the optional companion plugin only bridges plugin-specific features.
  If you never leave the app, [aaronsb/obsidian-mcp-plugin](https://github.com/aaronsb/obsidian-mcp-plugin)
  runs the whole server in-process, and community plugins may be all you need.
- **You want the best search with no setup and no network.** [engraph](https://github.com/devwhodevs/engraph)
  is a single binary with local models and no configuration. Our retrieval goes further on
  fusion and diversity and is gated by a statistical ship rule, but it asks more of you and
  its rerank stage is opt-in machinery today, not core: unreachable from the standalone
  compiled binaries, musl (Alpine) installs, or macOS x64.
- **You want agent memory that is not tied to one vault.** [basic-memory](https://github.com/basicmachines-co/basic-memory)
  keeps memory in its own portable markdown KB. Ours is deliberately *inside* the vault, so
  it inherits the vault's ACL and audit trail — a different trade, not a strictly better one.
- **You don't need MCP at all.** Obsidian URI or the Local REST API plugin can cover
  simple scripting directly.

Migrating the other way — replacing an existing Obsidian MCP setup with obsidian-tc — is
covered in [docs/CUTOVER.md](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/CUTOVER.md).
