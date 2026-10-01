# Tool Reference

**Every tool, by domain.** Canonical spec with full ACL / HITL / idempotency / rate-limit annotations and I/O schemas: [`docs/G2.1-tools.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/G2.1-tools.md) (design-era record + the post-1.0 additive ledger). This page is the at-a-glance index.

Every tool carries four annotations enforced by the dispatch pipeline: **acl** (`read` / `write` / `delete` / `execute` / `admin`), **hitl** (`never` / `required` / conditional), **idem** (`pure` / `natural` / `keyed` / `non-idem`), and **ratelimit** (`read` / `write` / `bulk`). See **[[Security and ACL]]**.

## The facade

What `tools/list` advertises is controlled by `toolFacade.mode`: **`triad`** (default — `find_capability`, `describe_capability`, `call_capability`), **`domain`** (~a dozen domain meta-tools taking `{ action, args }`), **`flat`** (the full surface), or **`auto`** (one of the three above, resolved per connecting client from its `clientInfo.name`; provisional table, precise on stdio and on HTTP for 2026-07-28 clients only). Every underlying tool stays callable by name in every mode; routing always goes through the same authorization pipeline.

## Response format

Tools that return more than an acknowledgement accept `response_format: "concise" | "detailed"`. Precedence: explicit `response_format` > the legacy `verbosity` alias > `tools.defaults.responseFormat` in config > `detailed` (the shipped default, unchanged output). Concise drops echo and bookkeeping fields but never a safety signal (`quality_warning`, a non-`none` `poison_assessment`, `redactions`, `patch_note` removal counts); errors are never shaped. Supported so far: `read_note`, `read_notes`, `get_active_file`, `write_note`, `append_note`, `patch_note`, `update_frontmatter` (the `*_active_file` tools pass it to their delegate), `read_frontmatter`, `find_notes_by_property`, `list_notes`, `get_outgoing_links`, `get_backlinks`, `find_unresolved_links`, `read_resources`, the search tools, `note_quality_report`, and (part 3) `list_attachments`, `list_periodic_notes`, `list_snapshots`, `list_capture_queue`, `list_goals`, `search_and_read`, `vault_graph_search`, `knowledge_search`, `get_entity`, `query_entity_graph`, `get_session_traces`, `session_bootstrap`, `work_episodes`, `work_episode_chain`, `work_search`, `gap_report`, `rewrite_link` and `prune_hub_links` (the last two trim only a real run). Reviewed and exempt, because there is nothing to drop: `list_tags`, `list_properties`, `list_vaults`, `list_bookmarks`, `list_workspaces`, `list_kanban_boards`, `list_commands`, `list_quickadd_actions`, `list_templates`, `list_tasks`, `list_contradictions`, `episode_stats`, `find_orphans` and the `plur_*` proxies. Every other tool (git, bases, canvas, Excalidraw, tables, bundles, OCR, `vault_context`, `reflect`, `knowledge_challenge`, `explain_answer`, `diagnose_retrieval`, `knowledge_get_critical`, writes and administration) is not yet covered and returns the full payload. `resources/read` takes no parameters, so only the config default applies to it (concise = the note body without frontmatter; scope, ACL, size ceiling and cache hints are unchanged). See **[[Configuration]]** for the config key.

## Domain groups

| Group | Domains | Examples |
| --- | --- | --- |
| **Notes & metadata** | vault registry, note CRUD, frontmatter, tags, links | `read_note`, `write_note`, `patch_note`, `update_frontmatter`, `get_backlinks` |
| **Search & retrieval** | text / regex / semantic / JSONLogic / DQL search, indexing | `search_vault`, `search_semantic`, `index_vault` |
| **Structured formats** | Bases, Canvas, Excalidraw, periodic notes, tasks, attachments, bookmarks, workspaces | `query_base`, `update_canvas`, `create_periodic_note`, `list_tasks` |
| **Plugin bridges** | Dataview, Templater, QuickAdd, OCR, Smart Context, make.md, commands | `eval_dataview_field`, `execute_template`, `execute_command` |
| **Memory & capture** | memory entities, capture queue, workspace traces, plur proxy | `add_observation`, `enqueue_capture`, `plur_recall` |
| **Knowledge & context (M7)** | GraphRAG, composite context, reflection, red-team challenge | `vault_graph_search`, `vault_context`, `reflect`, `knowledge_challenge` |
| **Work memory (M8, experiential)** | quarantined agent-episode store, eligibility-gated readers | `work_search`, `work_episodes`, `work_forget`, `record_retrieval_feedback` |
| **Git & sync bridges** | Obsidian Git (commit is HITL-floored), Remotely Save | `git_status`, `git_diff`, `git_commit`, `remotely_save_status` |
| **Bulk & URI** | bulk create / move / set-property, `obsidian://` URIs | `bulk_create_notes`, `bulk_move_notes`, `generate_uri` |
| **Server admin** | health, config, ACL introspection, metrics | `server_health`, `inspect_acl`, `get_metrics` |

## The original 28 domains (v1.0 surface)

| # | Domain | Tools |
|---|---|---|
| 1 | Multi-vault registry (4) | `list_vaults`, `get_vault`, `reload_vault`, `reset_vault_cache` |
| 2 | File / note CRUD (10) | `read_note`, `read_notes`, `list_notes`, `note_exists`, `write_note`, `append_note`, `patch_note`, `delete_note`, `move_note`, `copy_note` |
| 3 | Frontmatter / properties (5) | `read_frontmatter`, `read_property`, `update_frontmatter`, `list_properties`, `find_notes_by_property` |
| 4 | Tags (5) | `list_tags`, `get_note_tags`, `add_tag`, `remove_tag`, `find_notes_by_tag` |
| 5 | Links / backlinks / orphans (6) | `get_outgoing_links`, `get_backlinks`, `find_orphans`, `find_unresolved_links`, `rewrite_link`, `prune_hub_links` |
| 6 | Search (7) | `search_vault`, `search_text`, `search_regex`, `search_semantic`, `search_jsonlogic`, `search_dql`, `index_vault` |
| 7 | Bases `.base` (4) | `read_base`, `create_base`, `update_base`, `query_base` |
| 8 | Canvas `.canvas` (4) | `read_canvas`, `create_canvas`, `update_canvas`, `query_canvas` |
| 9 | Excalidraw (3) | `read_excalidraw`, `create_excalidraw`, `update_excalidraw` |
| 10 | Dataview standalone (2) | `validate_dql`, `eval_dataview_field` |
| 11 | Tasks (3) | `list_tasks`, `update_task`, `tasks_filter` |
| 12 | Periodic Notes (5) | `get_periodic_note`, `create_periodic_note`, `find_or_create_periodic_note`, `append_to_periodic_note`, `list_periodic_notes` |
| 13 | Templater (2) | `list_templates`, `execute_template` |
| 14 | QuickAdd (2) | `list_quickadd_actions`, `trigger_quickadd` |
| 15 | OCR / Text Extractor (2) | `ocr_attachment`, `ocr_bulk` |
| 16 | Smart Context bundling (2) | `bundle_folder`, `bundle_files` |
| 17 | make.md (2) | `makemd_list_spaces`, `makemd_query` |
| 18 | Workspaces (3) | `list_workspaces`, `open_workspace`, `save_workspace` |
| 19 | Bookmarks (3) | `list_bookmarks`, `add_bookmark`, `remove_bookmark` |
| 20 | Attachments (4) | `list_attachments`, `get_attachment`, `move_attachment`, `delete_attachment` |
| 21 | Capture / inbox queue (3) | `enqueue_capture`, `list_capture_queue`, `commit_capture` |
| 22 | Memory entities (5) | `create_entity`, `get_entity`, `add_observation`, `link_entities`, `query_entity_graph` |
| 23 | Workspace memory + traces (3) | `start_session`, `end_session`, `get_session_traces` |
| 24 | plur proxy (4) | `plur_recall`, `plur_recall_hybrid`, `plur_similarity_search`, `plur_get` |
| 25 | Bulk operations (3) | `bulk_create_notes`, `bulk_set_property`, `bulk_move_notes` |
| 26 | Command palette (2) | `list_commands`, `execute_command` |
| 27 | URI generation (1) | `generate_uri` |
| 28 | Server admin (4) | `get_server_config`, `inspect_acl`, `get_metrics`, `server_health` |

## Post-1.0 additions (the v1.4–v1.7 ledger)

- **Facade meta-tools** — `find_capability`, `describe_capability`, `call_capability` (+ domain-mode meta-tools). Boundary-only.
- **Knowledge domain (M7)** — `vault_graph_search` (GraphRAG: vector seeds + wikilink expansion fused with RRF), `knowledge_challenge` (red-team over decision history), `vault_context` (composite budgeted context with lesson surfacing + prewarm bootstrap), `reflect` (grounded synthesis / challenge / typed-delta preference profile).
- **Work-memory domain (M8)** — `work_search`, `work_episodes`, `work_forget`, `record_retrieval_feedback` — the experiential reader contract (eligible-only, tombstones, trust floor 0.3, caller partition).
- **Domain 30: Obsidian Git bridge** — `git_status`, `git_diff`, `git_log`, `git_stage`, `git_commit` (execute-family HITL floor — commits always require human confirmation).
- **Domain 31: Remotely Save bridge** — `remotely_save_status`, `remotely_save_trigger` (independent backup verification).
- **Additions to existing domains** — snapshots/restore, vault health, `add_vault`, markdown tables, kanban, filesystem Excalidraw read.
- **Offline CLI family** (not MCP tools — run against the same config + caches): `cluster`, `activation-recompute`, `citation-infer`, `contribution-report`, `prefetch`, `reflect`, `metrics`, `gaps`, `forget`, `context-export`, `context-import`. See the [server README](https://github.com/The-40-Thieves/obsidian-tc/blob/main/packages/server/README.md).

## Degradation & errors

A tool that needs an unavailable capability (a missing plugin, an unconfigured embedding provider) returns a typed error from the shared taxonomy (e.g. `plugin_missing`, `embedding_provider_error`) with a `retryable` flag — never an opaque failure. At the MCP boundary a dispatch failure surfaces as a Tool Execution Error (`isError: true` plus the structured error), so a model can self-correct.

Every error also carries a **`recovery`** string: bounded next-step guidance for that code, naming the tool to call next where one exists (`acl_denied` points at `inspect_acl`, `dql_error` at `validate_dql`, `plugin_missing` at `refresh_plugin_capabilities`). Where `retryable` says *whether* to retry, `recovery` says *what to do instead*. Hints are selected by error code alone, so they never echo a path, query, caller or vault back to the client.

## Full catalog (generated)

_Auto-generated from the tool registry — the exhaustive, always-current list. Run `bun run docgen:render`; do not hand-edit between the markers._

<!-- BEGIN GENERATED: tools -->

<!-- END GENERATED: tools -->
