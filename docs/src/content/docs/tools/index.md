---
title: Tool Reference
description: The ~128-tool surface obsidian-tc exposes to MCP clients, and the facade that shapes it.
---

obsidian-tc groups **~132 tools across modules M1–M8 plus admin**. Every tool has
a Zod-validated input schema, a structured result, a declared scope set, and a
scope class that selects its rate-limit tier. `tools/list` also derives MCP
**annotations** (`readOnlyHint` / `destructiveHint` / `openWorldHint`) and a
`title` from registry ground truth, and a tool may carry an optional `outputSchema`
and `icons`. Advertised schemas are **JSON Schema 2020-12** (the MCP `2025-11-25`
default dialect), matching the negotiated protocol version.

## Tool-surface facade

What `tools/list` advertises is controlled by `toolFacade.mode`:

- **`triad`** (default) — three meta-tools: `find_capability` (BM25 search over the
  catalog), `describe_capability` (a tool's schema + scopes), and `call_capability`
  (invoke by name). Discover, inspect, then call.
- **`domain`** — ~a dozen domain meta-tools (`notes`, `search`, `vault`, …), each
  taking `{ action, args }`.
- **`flat`** — the full underlying surface.

Every underlying tool stays callable by name in every mode, and `tools/list` is
filtered per caller scopes + tool-visibility ACL. Routing always goes through the
same authorization / ACL / HITL / idempotency / throttle pipeline.

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

## Degradation & errors

A tool that needs an unavailable capability (a missing plugin, an unconfigured
embedding provider) returns a typed error from the shared `ObsidianTcError`
taxonomy (e.g. `plugin_missing`, `embedding_provider_error`) with a `retryable`
flag — it never throws an opaque failure. At the MCP boundary a dispatch failure
surfaces as a **Tool Execution Error** (`isError: true` with human-readable text
plus the structured error as `structuredContent`), so a model can self-correct
rather than seeing a protocol error.

:::note
Per-tool reference pages auto-generated from the live `ToolRegistry` and its Zod
schemas are a deferred follow-up. This page is the curated overview.
:::
