---
title: Tool Reference
description: The 103-tool, 28-domain surface obsidian-tc exposes to MCP clients.
---

obsidian-tc exposes **103 tools across 28 domains**. Every tool has a
Zod-validated input schema, a structured result, a declared scope set, and a
scope class that selects its rate-limit tier.

## Domains

| Group | Domains | Examples |
| --- | --- | --- |
| **Notes & metadata** | notes, frontmatter, properties, tags, links, headings | `read_note`, `write_note`, `patch_note`, `update_frontmatter`, `get_backlinks` |
| **Search & retrieval** | text search, DQL, vector / hybrid search, embeddings | `search_vault`, `search_dql`, `search_semantic` |
| **Structured formats** | Bases, Canvas, periodic notes, tasks, outlines | `read_base`, `update_canvas`, `create_periodic_note`, `list_tasks` |
| **Plugin bridges** | Dataview, Templater, OCR, command execution, workspace | `eval_dataview_field`, `execute_template`, `execute_command` |
| **Memory & capture** | memory store, capture queue, workspace traces, PLUR proxy | `add_observation`, `enqueue_capture`, `plur_recall` |
| **Bulk & URI** | bulk note create / move / set-property, `obsidian://` URI generation | `bulk_create_notes`, `bulk_move_notes`, `bulk_set_property`, `generate_uri` |
| **Server admin** | health, config, ACL, metrics introspection | `server_health`, `get_server_config`, `inspect_acl`, `get_metrics` |

## Degradation

A tool that needs an unavailable capability (a missing plugin, an unconfigured
embedding provider) returns a typed error from the shared `ObsidianTcError`
taxonomy (e.g. `plugin_missing`, `embedding_provider_error`) with a `retryable`
flag — it never throws an opaque failure.

:::note
Per-tool reference pages auto-generated from the live `ToolRegistry` and its Zod
schemas are a deferred follow-up (G3). This page is the curated v1.0 overview.
:::
