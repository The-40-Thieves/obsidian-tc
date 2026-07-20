<!-- TEMPLATE / BLUEPRINT — Tool (API) Reference.
     The catalog between the GENERATED markers is produced from the tool registry by docgen (THE-472);
     do not hand-edit it. Prose outside the markers is hand-authored. -->

# Tool Reference

The MCP tools obsidian-tc exposes to agents. Each tool has a name, an input schema (Zod → JSON Schema), required scopes, and a structured result.

> [!NOTE]
> The catalog below is **generated from the tool registry** — it is always in sync with the running server. To regenerate: `< bun run docgen >`.

## Conventions

- **Scopes** — every tool declares `requiredScopes`; the caller's token/ACL must grant them.
- **Idempotency** — mutating tools accept an `idempotency_key` for safe retries.
- **Errors** — failures return a typed error (`{ code, message }`); see **[Error Codes](Error-Codes)**.

## Tool groups

| Group | Purpose |
|---|---|
| Read | `read_note`, `read_notes`, `list_notes`, `note_exists` |
| Write / Edit | `write_note`, `patch_note`, `append_note`, `update_frontmatter`, `delete_note`, `move_note` |
| Search | `search_vault`, `search_dql`, semantic / BM25 / graph modes |
| Index | `index_vault`, `add_vault`, `server_health` |
| Table / structured | `insert_table_row`, `insert_table_column` |

> [!TIP]
> `patch_note` does **atomic, anchored** edits — append/prepend/replace relative to a **heading section** or a **`^block-id`**, not just whole-file writes. This is how an agent surgically updates a note without rewriting it.

<!-- BEGIN GENERATED: tools -->
_143 tools. Access is a coarse hint; the required scopes are authoritative._

| Tool | Access | Scopes | Description |
|---|---|---|---|
| `add_bookmark` | write | `write:bookmarks` | Add a bookmark (optionally into a named group, created if absent). A duplicate is a no-op unless allow_duplicate is set. |
| `add_kanban_card` | write | `write:notes` | Add a card to a Kanban column (by name). Appends `- [ ] text` (or `- [x]` when checked) under the column heading, preserving the rest of the board. |
| `add_observation` | write | `write:memory` | Append a fact to a memory entity (re-materializing its note when materialized). |
| `add_tag` | write | `write:notes` | Add a tag to a note's frontmatter `tags` list or inline in the body (idempotent). |
| `add_vault` | write | `admin:vault` | Register a new vault at runtime (no restart). Validates the path is an existing directory, adds it to the registry, and indexes it for search. Runtime-only — add it to the config file to persist across restarts. |
| `append_note` | write | `write:notes` | Append content to a note (optionally creating it), preserving existing bytes. |
| `append_to_periodic_note` | write | `write:periodic` | Append content to a period's note (creating it if needed), optionally under a heading. idempotency_key is accepted (enforcement lands with the policy layer). |
| `audit_provenance` | read | `read:notes` | Provenance audit: flag claim-bearing notes that lack a 'sources' frontmatter field (the evidence a note's claims rest on), and report coverage of sources/confidence/verified across the readable note set. Read-only. Excludes daily notes, templates, and index files by default; tune scope with include/exclude globs and the field name. |
| `bulk_create_notes` | write | `write:notes`, `bulk:notes` | Batch-create notes with per-item results. Each item creates/overwrites/upserts a note (content + optional frontmatter). HITL-floored (bulk) and throttled; best-effort by default (stop_on_first_error opt-in). |
| `bulk_move_notes` | write | `write:notes`, `delete:notes`, `bulk:notes` | Batch-move notes and rewrite backlinks across the whole link graph (rewrite phase is all-or-nothing). dry_run (default true) previews predicted backlink updates without touching disk. Set overwrite to clobber existing destinations (each is soft-deleted to .trash, recoverable). HITL-floored (bulk) and throttled. |
| `bulk_set_property` | write | `write:notes`, `bulk:notes` | Set one frontmatter property across many notes, with per-item results (prev_value). HITL-floored (bulk) and throttled; best-effort by default (stop_on_first_error opt-in). |
| `bundle_files` | read | `read:context` | Aggregate an explicit list of notes into a single markdown/XML bundle. ACL-filtered; byte budgeted; reports missing_paths for files that do not exist. |
| `bundle_folder` | read | `read:context` | Aggregate all notes under a folder into a single markdown/XML bundle (Smart Context). ACL-filtered; file-count and byte budgeted with an explicit truncated flag. |
| `commit_capture` | write | `write:capture` | Write a queued capture to a vault path and mark it committed (or remove it from the queue). Refuses to overwrite an existing note. |
| `copy_note` | write | `write:notes` | Copy a note to a new path (backlinks are not rewritten for copies). |
| `create_base` | write | `write:bases` | Create a new .base file from a base definition. Overwriting an existing base requires confirmation. |
| `create_canvas` | write | `write:canvas` | Create a new .canvas with optional initial nodes/edges. Overwriting an existing canvas requires confirmation. |
| `create_entity` | write | `write:memory` | Create a typed memory entity (optionally materialized as a vault .md note). SQLite is the source of truth. |
| `create_excalidraw` | write | `write:excalidraw` | Create a new Excalidraw note via the companion plugin. Overwriting an existing drawing requires confirmation. |
| `create_periodic_note` | write | `write:periodic` | Create the periodic note for a period + date using the configured (or overridden) template. Fails if it already exists. Set expand_template=true to expand the template through Templater (requires write:templater; degrades to a verbatim copy when the companion/plugin is unavailable). |
| `delete_attachment` | destructive | `delete:attachments` | Delete an attachment (to the vault's .trash mirror, or permanently). Destructive — requires confirmation. Reports notes that still reference it. |
| `delete_note` | destructive | `delete:notes` | Delete a note (to the vault's .trash mirror, or permanently). Destructive — requires confirmation. |
| `end_session` | write | `write:workspace` | Finalize a workspace session, appending a session_end record to its JSONL trace. |
| `enqueue_capture` | write | `write:capture` | Stage content in the SQLite capture queue for later commit to the vault (no vault write at enqueue time). |
| `eval_dataview_field` | read | `read:dataview` | Evaluate a Dataview field expression against a single note (useful for property derivation). |
| `execute_command` | write | `execute:command` | Fire an Obsidian command by id. Deny-by-default and triple-gated: requires human confirmation (execute:command is a HITL floor), command execution must be enabled for the vault, and the id must be on the vault allowlist. Falls back to Local REST API's native /commands/{id}/ route when the companion is unreachable. Never silently runnable. |
| `execute_template` | write | `write:templater` | Run a Templater template and write the expanded output to a target path. Always requires human confirmation (write:templater is a HITL floor) because templates can execute arbitrary user JavaScript. |
| `find_link_cycles` | read | `read:notes` | Detect circular internal-link chains (a -> b -> ... -> a) in the readable note graph. Returns up to `limit` cycles as ordered path lists. |
| `find_notes_by_property` | read | `read:notes` | Find notes whose frontmatter has a key (optionally equal to a value, or containing it when the value is a list). Set verbosity=terse to return path only (dropping the matched value). Set nested=true to match a dotted key path. |
| `find_notes_by_tag` | read | `read:notes` | Find notes carrying a tag, hierarchically (a query for `project` matches `project` and `project/sub`). |
| `find_or_create_periodic_note` | write | `read:periodic`, `write:periodic` | Get the periodic note for a period + date, creating it (empty/template) if absent. With expand_template=true a newly created note is expanded through Templater when available (requires write:templater). |
| `find_orphans` | read | `read:notes` | Find notes that nothing else links to (optionally also requiring no outgoing links). |
| `find_unresolved_links` | read | `read:notes` | Find internal links that do not resolve to any note (dangling links). |
| `format_table` | write | `write:notes` | Reformat a GFM markdown table in a note: realign columns to a uniform width, honoring the delimiter row's alignment. Addressed by 0-based table_index within the note. |
| `generate_uri` | read | — | Build an obsidian:// URI for a target (open/search/new/daily/command/hookmark/advanced). Pure string builder — touches no vault state, requires no scope. The vault display name is used verbatim. |
| `get_attachment` | read | `read:attachments` | Read an attachment's bytes (base64) plus MIME type and size. Fails with invalid_input when the file exceeds max_bytes. |
| `get_backlinks` | read | `read:notes` | Find every note that links to the given note, with source line/column. |
| `get_entity` | read | `read:memory` | Read a memory entity by id, by type+name, or by unique name, with its observations and relations. |
| `get_link_strength` | read | `read:notes` | Score the connection strength (0-1) between two notes from the link graph: direct edge, co-citation (shared inbound sources), shared outbound neighbors, and undirected graph distance. |
| `get_metrics` | write | `admin:metrics` | Snapshot Prometheus-style metrics as structured JSON: per-(vault,tool,status) invocation counters and rate-limit-hit counters aggregated from the local event_log + live limiter, plus uptime/registered-vault/registered-tool gauges. Optionally filter to one vault. |
| `get_note_tags` | read | `read:notes` | Get a note's tags, split into frontmatter, inline, and the combined set. |
| `get_outgoing_links` | read | `read:notes` | List a note's outgoing links (code-block links excluded), each resolved to a target path. |
| `get_periodic_note` | read | `read:periodic` | Get the periodic note for a period + date (no creation). Resolves the path from the vault's daily/periodic config or Obsidian defaults. |
| `get_server_config` | write | `admin:config` | Read the non-secret server config: auth mode, server-global read_only + embeddings provider, throttle limits, observability targets, and a per-vault summary (id) plus a detected-plugins map. Never returns secrets. |
| `get_session_traces` | read | `read:workspace` | Replay JSONL trace records for one session, or across a started-at date window, with optional tool filtering. |
| `get_vault` | read | `read:vault` | Inspect a single vault's configuration and cache state. |
| `git_commit` | write | `execute:git` | Commit the staged changes of the vault's git repo. Always requires human confirmation (execute:git is a HITL-floor family) — a commit is irreversible-in-effect from the agent's side. |
| `git_diff` | read | `read:git` | Unified diff for one vault file (working tree, or the staged copy with staged: true), via the Obsidian Git companion bridge. |
| `git_log` | read | `read:git` | Recent commits of the vault's git repo (hash/message/author/date), via the Obsidian Git companion bridge. Unavailable under a read whitelist (log messages enumerate paths). |
| `git_stage` | write | `write:git` | Stage vault files for the next commit, via the Obsidian Git companion bridge. Write-family: the readOnly kill switch applies. |
| `git_status` | read | `read:git` | Working-tree status of the vault's git repo (changed/staged/conflicted), via the Obsidian Git companion bridge. Unavailable under a read whitelist (repo status enumerates every path). |
| `index_vault` | write | `admin:vault` | Chunk and embed the vault (or a folder) into the search index. Incremental: chunks whose content hash is unchanged are skipped; removed chunks are pruned. |
| `insert_table_column` | write | `write:notes` | Insert a column into a GFM table: a header plus per-row values (default empty) and an alignment. `at` is the 0-based column position (default: append). |
| `insert_table_row` | write | `write:notes` | Insert a data row into a GFM table. `values` are cell strings (padded/truncated to the column count); `at` is the 0-based data-row position (default: append). |
| `inspect_acl` | write | `admin:acl` | Test whether a (vault, path, op, scopes) tuple would be permitted. Shares the live path evaluator (read-only kill switch + per-op whitelist) so it cannot drift from enforcement, then checks the op-family scope grant. Reports the matched path rule, the rule-based effective_scopes, and what denied it. |
| `knowledge_challenge` | read | `read:notes` | Red-team a proposal against your documented decision history. Retrieves decision-bearing chunks (02-projects, 04-writing/Published, 09-reference/system-reviews, 09-reference/syntheses) and asks the inference gateway to flag DIRECT_CONTRADICTION / PATTERN_REPEAT / REVERSAL / HIDDEN_DEPENDENCY. Requires the gateway; reports unavailable when it is not configured. |
| `knowledge_get_critical` | read | `read:docs` | List the critical-severity docs in a vendor / external-docs corpus: the breaking changes, security issues, and production gotchas to read before starting work. A tight metadata pre-filter over frontmatter severity == 'critical', not a search. Optionally narrow by `source` (the vendor or tool the doc is about). Gated on read:docs so it stays isolated from the private vault. |
| `knowledge_search` | read | `read:docs` | Semantic + keyword search over a vendor / external-docs corpus (a reserved read-only docs vault), with wikilink graph expansion and RRF fusion. The docs-scoped analogue of vault_graph_search: bind `vault` to the docs corpus id. Returns source-attributed chunks tagged seed\|expansion. Gated on read:docs so it stays isolated from the private vault. |
| `link_entities` | write | `write:memory` | Create a typed relation between two memory entities (idempotent; re-materializes the source's [[links]]). |
| `list_attachments` | read | `read:attachments` | List attachment files in the vault (filtered by extension, read-ACL aware), with cursor pagination. Optionally count referencing notes per file. |
| `list_bookmarks` | read | `read:bookmarks` | List the vault's bookmarks tree (.obsidian/bookmarks.json), preserving groups and unknown fields. |
| `list_capture_queue` | read | `read:capture` | List captures in the queue (pending by default; committed:true lists committed), newest first. |
| `list_commands` | read | `read:command` | Enumerate available Obsidian commands (optional substring filter). Uses the companion plugin, falling back to Local REST API's native /commands/ route when the companion is unreachable. |
| `list_kanban_boards` | read | `read:notes` | List Kanban board notes in the vault (frontmatter kanban-plugin: board), with column and card counts. |
| `list_notes` | read | `read:notes` | List notes under a folder (read-ACL filtered), with cursor pagination. |
| `list_periodic_notes` | read | `read:periodic` | Enumerate existing periodic notes in a date range (probes the configured format/folder). Defaults to a recent window when from/to are omitted. |
| `list_properties` | read | `read:notes` | Aggregate frontmatter property keys across notes, with usage counts and value types. |
| `list_quickadd_actions` | read | `read:quickadd` | Enumerate configured QuickAdd actions (template/macro/capture/multi) via the companion bridge. |
| `list_snapshots` | read | `read:notes` | List a note's point-in-time snapshots, newest first (id, op, content_hash, size, created_at). |
| `list_tags` | read | `read:notes` | Aggregate all tags (frontmatter + inline) across notes, with usage counts. |
| `list_tasks` | read | `read:tasks` | List tasks across the vault (or a root/paths subset) with typed status/priority/tag/due filters. Filesystem-only; needs no plugin. |
| `list_templates` | read | `read:templater` | List available Templater templates with parsed metadata (user functions, parameters), via the companion bridge. |
| `list_vaults` | read | `read:vault` | List configured vaults and their cache state. |
| `list_workspaces` | read | `read:workspaces` | List saved workspace names and the active workspace (.obsidian/workspaces.json). |
| `makemd_list_spaces` | read | `read:makemd` | Enumerate make.md spaces (its alternative to folders) via the companion bridge. |
| `makemd_query` | read | `read:makemd` | Run a make.md query against a space (filter/sort/paginate) via the companion bridge. |
| `move_attachment` | write | `write:attachments`, `delete:attachments` | Move/rename an attachment and repoint note links to it (link style preserved). Crossing a folder boundary or overwriting requires confirmation. |
| `move_kanban_card` | write | `write:notes` | Move a card (matched by text) from one Kanban column to another, preserving its original line (checkbox state, inline metadata). |
| `move_note` | write | `write:notes`, `delete:notes` | Move/rename a note and update backlinks. Crossing a folder boundary OR overwriting an existing destination requires confirmation; an overwritten destination is soft-deleted to .trash (recoverable). |
| `note_exists` | read | `read:notes` | Check whether a path exists in the vault and whether it is a file or folder. |
| `ocr_attachment` | read | `read:ocr` | Run OCR on a single image or PDF attachment via the Text Extractor bridge. Returns extracted text (cached by the plugin per file+model). |
| `ocr_bulk` | read | `read:ocr` | OCR a batch of attachments via the Text Extractor bridge. Resolves and ACL-filters the candidate set server-side; requires confirmation past 20 files. |
| `open_workspace` | write | `write:workspaces` | Mark a saved workspace active and return its stored layout. Fails if the workspace does not exist. |
| `patch_note` | write | `write:notes` | Insert or replace content (append/prepend/replace) relative to an anchor: a heading section, a block reference (anchor:{type:"block",block_id}), or the note preamble above the first heading (anchor:{type:"frontmatter"}). Frontmatter is preserved. |
| `plur_get` | read | `read:plur` | Fetch a specific plur engram by id (read-only proxy). |
| `plur_recall` | read | `read:plur` | BM25 keyword recall over the global plur engram store (read-only proxy). |
| `plur_recall_hybrid` | read | `read:plur` | Hybrid BM25 + embedding recall (RRF) over the global plur engram store. |
| `plur_similarity_search` | read | `read:plur` | Cosine similarity search over plur engram embeddings (read-only proxy). |
| `prune_hub_links` | write | `write:notes` | Prune unresolved and/or duplicate links from a hub note. Defaults to dry_run; a real run requires confirmation. |
| `query_base` | read | `read:bases` | Execute a base view and return resolved rows. Filters/formulas may use obsidian-tc's JSONLogic model OR the real Obsidian Bases expression DSL (a documented subset, THE-281); constructs outside the subset — and trees mixing both models — are refused with unsupported_base_filter. |
| `query_canvas` | read | `read:canvas` | Find nodes matching criteria across one or more .canvas files (defaults to all canvases under the vault root). |
| `query_datacore` | read | `read:datacore` | Run a Datacore query using its own query language (e.g. `@page and #tag`, `@task and $completed = false`) and return matching pages/blocks with their path, name, tags, types, and frontmatter fields. Datacore is Dataview's successor; use search_dql for classic Dataview DQL. |
| `query_entity_graph` | read | `read:memory` | Traverse the memory graph from a seed entity (BFS, depth-limited, type/direction filtered). |
| `read_base` | read | `read:bases` | Read a .base file's structure (source, views, formulas). |
| `read_canvas` | read | `read:canvas` | Parse a .canvas file into its nodes and edges (JSONCanvas spec). |
| `read_excalidraw` | read | `read:excalidraw` | Read an Excalidraw drawing's raw elements and/or extracted text. source=plugin (default) proxies the live companion plugin; source=filesystem parses the .excalidraw / .excalidraw.md file on disk (works headlessly, no plugin); source=auto tries the plugin and falls back to the filesystem when it is unavailable (THE-202). |
| `read_frontmatter` | read | `read:notes` | Read a note's parsed YAML frontmatter (null when the note has none). |
| `read_kanban_board` | read | `read:notes` | Parse a Kanban board note into its columns and cards (text + checked state). |
| `read_metadata_fields` | read | `read:metadata-menu` | Read a note's typed metadata fields via the Metadata Menu plugin: returns each configured field's name, value, type, validity, and source (frontmatter vs inline). Read-only field introspection. |
| `read_note` | read | `read:notes` | Read a note's raw content, parsed frontmatter, body, content hash, and stat. |
| `read_notes` | read | `read:notes` | Batch-read notes. Returns successful notes and a per-path error list (partial). |
| `read_property` | read | `read:notes` | Read a single frontmatter property. Set nested=true to address a dotted path (e.g. meta.author.name) through nested objects. |
| `read_snapshot` | read | `read:notes` | Read the full stored content of a single snapshot by id. |
| `record_retrieval_feedback` | write | `write:workspace` | Stamp relevance feedback and/or the THE-230 outcome axis (-1\|0\|+1) onto the most recent retrieval event(s) for a chunk in the experiential log. feedback = 'was this the right chunk'; outcome = 'did acting on it lead somewhere good'. Feeds the ACT-R activation recompute. |
| `reflect` | read | `read:notes` | The reflect verb (retain/recall/reflect): recall over the vault, then a gateway synthesis pass — one on-demand, query-scoped operation returning a grounded answer with source provenance. mode 'challenge' runs the adversarial red-team over the decision-bearing recall instead (the knowledge_challenge core). persist: true writes the answer as a derived note under the memory folder's reflections/ with source_model + chunk provenance (requires write:notes). Degrades gracefully: without the inference gateway, recall still returns sources with available: false. The sleep-time half (episode-eligibility evaluator + preference profile) runs via the `obsidian-tc reflect` CLI command. |
| `reload_vault` | write | `admin:vault` | Re-read a vault's configuration from disk (does not touch the cache). |
| `remotely_save_status` | read | `read:remotely-save` | Last sync state of the Remotely Save plugin (sync status + last successful sync time) — an independent backup-verification signal, via the companion bridge. |
| `remotely_save_trigger` | write | `write:remotely-save` | Kick off a Remotely Save sync run (fire-and-poll: check remotely_save_status afterwards), via the companion bridge. |
| `remove_bookmark` | destructive | `delete:bookmarks` | Remove every bookmark matching the criteria (recursively, or within a named group). Returns the number removed. |
| `remove_tag` | write | `write:notes` | Remove a tag from a note's frontmatter, its body, or both (exact, not hierarchical). |
| `reset_vault_cache` | destructive | `admin:vault` | Drop the SQLite cache for a vault (chunks, embeddings, idempotency keys; optionally the event log). Destructive — requires confirmation. |
| `resolve_daily_note` | read | `read:daily-notes` | Resolve the daily note for a date (default today) via the core Daily Notes plugin's configured folder + format. Returns whether it exists and its path — no path guessing. Read-only; does not create. |
| `restore_note` | write | `write:notes` | Restore a note to a prior snapshot's content. Destructive — overwrites the current note (whose current state is itself snapshotted first when snapshots are enabled, so the restore is reversible) and requires confirmation. |
| `rewrite_link` | write | `write:notes` | Repoint every link to `from_target` at `to_target` across the vault. Defaults to dry_run; a real run requires confirmation. |
| `save_workspace` | write | `write:workspaces` | Save a workspace layout under a name (optionally making it active). Overwriting an existing workspace requires confirmation. |
| `search_dql` | read | `read:notes`, `read:dataview` | Run a Dataview DQL query via the companion plugin bridge. Returns headers/rows and the matched note paths. Requires the Dataview bridge; reports plugin_missing when it is not configured. |
| `search_jsonlogic` | read | `read:notes` | Filter notes with a JSONLogic expression over frontmatter + { path, content }. Returns matching note paths. |
| `search_omnisearch` | read | `read:omnisearch` | Ranked full-text search over the vault via the Omnisearch plugin. Returns scored matches with per-note excerpts and matched words. Complements the built-in search domain with Omnisearch's own ranking. |
| `search_regex` | read | `read:notes` | Regular-expression search across vault notes. Each match returns line/col + the matched text; capped per file. Pattern length is bounded, patterns with nested quantifiers are rejected, and execution is time-budgeted (governor.regexTimeoutMs) to prevent catastrophic backtracking; flags may only be i, m, s, u. |
| `search_semantic` | read | `read:notes` | Dense-vector retrieval over the chunk store (run index_vault first). Returns the top-k chunks by cosine similarity. verbosity=terse drops chunk content/metadata, returning path/score only. |
| `search_text` | read | `read:notes` | Literal text search across vault notes (BM25-ranked). Supports case_sensitive and whole_word; scoped to an optional root folder. |
| `search_vault` | read | `read:notes` | Unified search dispatch. mode=auto routes a string query text->semantic (fallback on zero hits) and an object query to jsonlogic; or force text/regex/semantic/jsonlogic/dql. Set verbosity=terse to compact each hit to path/score/snippet. |
| `server_health` | read | — | Liveness + build info. Round-trips the full transport -> auth -> acl -> audit path. |
| `session_bootstrap` | read | `read:notes` | Triage an opening session message (auto -> lightweight \| standard \| deep) and preload the matching vault context notes, so any MCP client gets session bootstrap, not only skill-enabled ones. Deep loads the configured deepPaths; standard loads the paths of every domain whose signals appear in the message; lightweight loads nothing. The routing table comes from server config (bootstrap.*); with none configured the tool degrades to lightweight. Read-only. |
| `snapshot_note` | read | `read:notes` | Capture the current content of a note as a restorable point-in-time snapshot (retained per config.snapshots.retention). Returns the snapshot id and content hash. |
| `sort_table_by_column` | write | `write:notes` | Sort a GFM table's data rows by a column (index or header name), ascending or descending, optionally numeric. |
| `start_session` | write | `write:workspace` | Begin a workspace memory session: a SQLite row plus an append-only JSONL trace file. |
| `suggest_links` | read | `read:notes` | Suggest notes to link a given note to, from the link graph (co-citation with the note's inbound sources + 2-hop outbound neighbors), excluding notes it already links to. Graph-based (no embeddings). |
| `tasks_filter` | read | `read:tasks` | Run a Tasks-plugin filter expression (its DSL) via the companion bridge, with optional grouping/sorting. Requires the Tasks plugin; if it is unavailable, use list_tasks for native status/priority/tag/due filtering. |
| `trigger_quickadd` | write | `execute:quickadd` | Fire a QuickAdd action by name. Always requires human confirmation (execute:quickadd is a HITL floor): actions can create or modify notes broadly and run macros. |
| `update_base` | write | `write:bases` | Patch a .base file's source/filters/properties/views/formulas. Unknown keys are preserved. Changing `source` (deprecated alias) or the note-set-defining top-level `filters` requires confirmation. |
| `update_canvas` | write | `write:canvas` | Patch a .canvas: add/remove/update nodes and edges by id. Unknown fields are preserved. Removing more than 10 nodes requires confirmation. |
| `update_excalidraw` | write | `write:excalidraw` | Add, remove, or update elements in an existing Excalidraw note via the companion plugin. |
| `update_frontmatter` | write | `write:notes` | Mutate a note's frontmatter (set/remove/merge/replace). `replace` discards all existing metadata and requires confirmation. Optional prev_hash gives compare-and-swap. Set nested=true to address a dotted key path for set/remove (intermediate objects are created as needed). |
| `update_task` | write | `write:tasks` | Modify a task in place by line number (status, dates, priority, tags). Reopening a task completed more than 7 days ago requires confirmation. |
| `validate_dql` | read | `read:dataview` | Parse a Dataview DQL query without executing it. Returns the AST or a parse-error location. |
| `vault_context` | read | `read:notes` | Composite budgeted context in ONE call (the Honcho-style context() primitive): graph-reranked chunks packed to a token budget and grouped by note, recent synthesis patterns touching the query, open contradictions on the packed notes, and applicable past lessons (decision/lesson/postmortem chunks relevant to the query) — with source metadata and packing stats. include_work adds eligible work-memory episodes (the THE-229 reader contract; explicit opt-in, never default). Omit query for session bootstrap: the queued thread is read from the memory folder's _next-session.md signal note, so every session opens with its applicable lessons (push, not pull). |
| `vault_graph_search` | read | `read:notes` | Cross-domain / multi-hop semantic search with wikilink graph expansion (GraphRAG). Seeds by vector similarity, expands through the links_to graph (vault_edges), and fuses by RRF. Run index_vault first so the edge graph is populated. Returns chunks tagged seed\|expansion with hop + via_edge. |
| `vault_health_score` | read | `read:notes` | Composite vault link-health score (0-100) with a breakdown: orphan count, unresolved-link count, hub density, and cycle count over the readable note graph. |
| `work_episodes` | read | `read:workspace` | List/inspect the raw experiential episode log (management surface, the first-party list/inspect verb). Shows pending and ineligible state for review; tombstoned rows stay hidden unless include_blocked. Partitioned to the calling principal unless any_caller. |
| `work_forget` | write | `write:workspace` | Tombstone an experiential episode (the THE-238 control-1 blocklist, surfaced as the first-party forget verb). A forgotten episode never surfaces in work_search again; the append-only log row remains for forensics. Idempotent. |
| `work_search` | read | `read:workspace` | Search the experiential work-memory (agent_episodes) — what the agent actually did. MEMORY semantics with the THE-238 reader contract enforced: only evaluator-approved (eligible) episodes by default, tombstoned/expired rows never surface, results are partitioned to the calling principal, and a trust floor (default 0.3) excludes high-risk content. include_pending opts into not-yet-evaluated episodes (still trust-floored); any_caller crosses the agent partition explicitly. |
| `write_note` | write | `write:notes` | Create, overwrite, or upsert a note. Optional prev_hash gives compare-and-swap; overwriting a non-empty note requires confirmation. |
<!-- END GENERATED: tools -->

## See also

- [Reading & Writing Notes](Reading-and-Writing-Notes) — task-oriented guide
- [Search: Vector, BM25 & Graph](Search) — retrieval modes explained
- [Configuration Reference](Configuration-Reference)
