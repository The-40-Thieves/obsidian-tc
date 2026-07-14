---
title: Concepts
description: The core building blocks — vaults, tools, the facade, scopes, transports, and the companion plugin.
---

## Vaults

A **vault** is an Obsidian vault directory. obsidian-tc is multi-vault: each entry
in `vaults` has an `id`, a `path`, and optional per-vault settings (bridge URLs,
memory folder, command allowlist). Every tool call targets one vault.

## Tools

The server groups **~141 typed tools across modules M1–M8 plus admin** — notes,
metadata, links, search, embeddings, structured formats (Bases, Canvas, periodic
notes), plugin bridges, memory, capture, bulk operations, URI generation, and
server admin. Each tool has a Zod-validated input schema, derived MCP annotations,
and a structured result. See the [Tool Reference](/tools/).

## Tool-surface facade

`toolFacade.mode` controls what `tools/list` advertises: **`triad`** (default)
exposes three meta-tools (`find_capability`, `describe_capability`,
`call_capability`) for progressive discovery; **`domain`** exposes ~a dozen domain
meta-tools taking `{ action, args }`; **`flat`** advertises every tool. In every
mode each tool stays callable by name, and `tools/list` is further filtered per
caller scopes + tool-visibility ACL.

## The memory engine

Beyond vault access, the server maintains a **quarantined experiential store**
(`experiential.db`, physically separate from your authored notes): every serve-path
retrieval is logged, every agent tool call is captured as a work episode
(poison-scanned at write; retrievable only after an evaluator stamps it eligible),
and derived usage statistics are views over that log — nothing ever mutates the
authored store. Two composite tools sit on top: **`vault_context`** returns a
budget-packed context bundle in one call (graph-reranked chunks, synthesis
patterns, open contradictions, applicable past lessons — with a TTL-enforced
prewarm cache for session bootstrap), and **`reflect`** produces a grounded,
source-attributed synthesis with an adversarial challenge mode. Deletion
propagates: the `forget` CLI clears derived state and appends to a hash-chained
audit log. Retrieval quality is gated by a golden-set eval harness — ranking
changes ship only with measured wins. Experimental retrieval mechanisms — learned-sparse and ColBERT rerank streams, and **graph densification** (derived tag / kNN / LLM edges added to the wikilink graph, `retrieval.densify.*`) — ship **off by default** behind flags until they clear that bar.

## Scopes & scope classes

Every tool declares the scopes it requires (`family:resource`, e.g. `read:notes`,
`write:notes`). Scopes drive both **authorization** (ACLs) and **rate limiting**:
each tool maps to a scope *class* — `read`, `write`, `delete`, `bulk`, `execute`,
or `admin` — and the class selects a throttle tier.

## Transports

- **stdio** — the trusted local transport; full local scope, no auth.
- **HTTP** — opt-in, for remote agents; gated by signed-JWT auth and ACLs.

## Companion plugin

Bridge tools reach a running Obsidian instance through the companion plugin's Local
REST API. Without it the server still runs; bridge tools degrade gracefully to
`plugin_missing` / `plugin_unreachable`.
