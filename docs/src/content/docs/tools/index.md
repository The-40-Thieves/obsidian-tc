---
title: Tool Reference
description: The 105-tool, 28-domain surface obsidian-tc exposes to MCP clients.
---

obsidian-tc exposes **105 tools across 28 domains**. Every tool has a
Zod-validated input schema, a structured result, a declared scope set, and a
scope class that selects its rate-limit tier.

## Domains

| Group | Domains | Examples |
| --- | --- | --- |
| **Notes & metadata** | notes, frontmatter, properties, tags, links, headings | `read_note`, `write_note`, `patch_note`, `set_frontmatter`, `get_backlinks` |
| **Search & retrieval** | text search, DQL, vector / hybrid search, embeddings | `search_vault`, `search_dql`, `semantic_search` |
| **Structured formats** | Bases, Canvas, periodic notes, tasks, outlines | `read_base`, `edit_canvas`, `daily_note`, `list_tasks` |
| **Plugin bridges** | Dataview, Templater, OCR, command execution, workspace | `run_dql`, `execute_template`, `run_command` |
| **Memory & capture** | memory store, capture queue, workspace traces, PLUR proxy | `memory_write`, `capture`, `recall` |
| **Bulk & URI** | bulk read/write/move/delete, `obsidian://` URI generation | `bulk_read`, `bulk_write`, `bulk_delete`, `build_uri` |
| **Server admin** | health, config, ACL, metrics introspection | `get_health`, `get_server_config`, `get_metrics` |

## Degradation

A tool that needs an unavailable capability (a missing plugin, an unconfigured
embedding provider) returns a typed error from the shared `ObsidianTcError`
taxonomy (e.g. `plugin_missing`, `embedding_provider_error`) with a `retryable`
flag — it never throws an opaque failure.

:::note
Per-tool reference pages auto-generated from the live `ToolRegistry` and its Zod
schemas are a deferred follow-up (G3). This page is the curated v1.0 overview.
:::
