---
title: Tool Reference
description: The tool surface obsidian-tc exposes to MCP clients, and the facade that shapes it.
---

obsidian-tc groups **its tools across modules M1–M8 plus admin**. Every tool has
a Zod-validated input schema, a structured result, a declared scope set, and a
scope class that selects its rate-limit tier. `tools/list` also derives MCP
**annotations** (`readOnlyHint` / `destructiveHint` / `openWorldHint`) and a
`title` from registry ground truth, and a tool may carry an optional `outputSchema`
and `icons`. Advertised schemas are **JSON Schema 2020-12** (the MCP `2025-11-25`
default dialect), matching the negotiated protocol version.

For how to connect and call these over MCP — stdio or HTTP, auth, and the discover → describe → call flow — see the [API Reference](/tools/api-reference/).

## Tool-surface facade

What `tools/list` advertises is controlled by `toolFacade.mode`:

- **`triad`** (default) — three meta-tools: `find_capability` (BM25 search over the
  catalog), `describe_capability` (a tool's schema + scopes), and `call_capability`
  (invoke by name). Discover, inspect, then call.
- **`domain`** — ~a dozen domain meta-tools (`notes`, `search`, `vault`, …), each
  taking `{ action, args }`.
- **`flat`** — the full underlying surface.
- **`auto`** — picks one of the three above **per connecting client**, from its
  observed MCP `clientInfo.name`, and caches the choice for the rest of that
  client's session once a NAME is actually observed (a request that carries no
  observable name at all gets the `triad` fallback WITHOUT pinning the
  connection to it — the first later request that does carry a name still
  resolves for real). `toolFacade.autoClients` maps a case-insensitive
  substring of the client name to a mode (checked in the config's own key
  order, before the built-in table below — a match here overrides the same
  substring there); a client matching nothing gets `triad`. The built-in table
  is:

  **Where `auto` actually resolves.** Client identity is observed per request
  from the MCP request envelope (or, for a legacy client, from the
  `initialize` handshake). On **stdio**, one connection is served by ONE
  long-lived `Server` instance for its whole life, so `auto` resolves on
  either protocol era — a legacy client's `initialize`-only identity is still
  seen. On **Streamable HTTP**, every request is served by a brand-new,
  stateless `Server` instance with no memory of any earlier request on that
  same TCP connection: a 2026-07-28 client resolves correctly because it
  resends `clientInfo` in `_meta` on every request, but a 2025-11-25 (legacy)
  client over HTTP only ever declares `clientInfo` at `initialize` — a
  DIFFERENT `Server` instance than the one that later serves `tools/list` — so
  it always gets the untargeted `triad` fallback. `auto` is therefore precise
  on stdio (both eras) and on HTTP for 2026-07-28 clients; a legacy client
  connecting over HTTP should set `toolFacade.mode` explicitly instead of
  relying on `auto`.

  | Client name contains | Mode | Why (provisional) |
  | --- | --- | --- |
  | `claude-code` | `domain` | Ships its own client-side tool search, so the triad's find/describe layer duplicates it — domain's grouped meta-tools give it real verbs to search over instead. |
  | `cursor` | `triad` | A 40-tool cap has been reported but is unverified — kept at the existing default. |
  | *(anything else)* | `triad` | The existing, ADR-anchored default. |

  **This table is a starting point, not a measurement.** Nothing here has yet
  measured tool-*selection* accuracy per client — only per raw tool count (see
  `docs/adr/0006-the-default-surface-is-the-triad.md`). A follow-up ticket will
  replace it with per-client data; until then, override any entry with
  `toolFacade.autoClients` in your config.

  **Explaining an `auto` decision.** Set `toolFacade.explainAutoMode: true`
  (default `false`) to see why a client got the mode it did, without changing
  it. Each resolution writes one `obsidian-tc toolFacade.explain {...}` JSON
  line to stderr, and the `explanation` field of `server_health`'s `toolFacade`
  block returns the same record for the calling client. The record lists the signals the matcher
  actually reads — the observed `clientName` (name only, bounded and stripped of
  control characters), the `configuredKeys` from `toolFacade.autoClients` and the
  `builtInKeys` it checked, in match order — plus the `rule` that fired
  (`no-client-name`, `configured-override`, `built-in-table` or `no-match`), the
  `matchedKey`, the `fallback`, and the `mode` chosen. Tool-search support is
  not a separate input: the built-in table above encodes it per client name.
  Tool count, tags and `toolFacade.profile` do not affect the decision and so
  do not appear. `obsidian-tc doctor` (offline) reports the flag and warns when
  it is set under a mode other than `auto`; the live, per-client view is
  `server_health`.

Every underlying tool stays callable by name in every mode, and `tools/list` is
filtered per caller scopes + tool-visibility ACL. Routing always goes through the
same authorization / ACL / HITL / idempotency / throttle pipeline.

## Tool profile

`toolFacade.mode` (above) picks what a given **session** is advertised. A separate,
deployment-level setting, `toolFacade.profile`, picks which tools are **visible and
callable** at all. Registration itself never changes — every tool is always
registered (`server_health`/`inspect_visibility` can always name all 164) — only
dispatch-time visibility does:

- **`full`** (the default) — every tool stays visible/callable, exactly as today.
  **This ticket does not change the default.** A usage report over 4,787 recorded
  calls (GitHub issue #877) found 97 of 164 tools never called once — but it names
  only five tools as confirmed zero-call, not whole families, and the same
  reporter separately filed a whole issue (#879) praising one of the tools an
  earlier draft of this feature would have hidden. Flipping the default needs its
  own evidence-gated decision, not a side effect of adding the mechanism — see
  `docs/adr/` for that bar.
- **`core`** (opt-in) — a smaller, curated surface for an operator who wants one.
  Five graph-analysis tools (`graph_centrality`, `graph_communities`,
  `suggest_links`, `find_link_cycles`, `prune_hub_links`) are the ONLY ones with
  direct usage evidence behind the cut (#877 names them explicitly as zero-call).
  The rest of the curation — the structured-document family (Bases, Canvas,
  Kanban, periodic notes, bookmarks, attachments, tables) and the plugin-bridge
  family (Excalidraw, MakeMD, Remotely Save, OCR, git, Templater, QuickAdd,
  Dataview, and siblings) — is a STRUCTURAL choice (every member proxies to a live
  companion plugin and degrades when it is absent), not a usage claim; #877 gives
  no evidence either way for these. `bundle_files`/`bundle_folder` stay in `core`
  despite living in the plugin-bridge domain: both are pure filesystem (no
  companion dependency) and `bundle_folder` has direct positive usage evidence
  (#879). Everything the triad facade, the memory tools (M5/M7/M8), catalog
  discovery, health/admin, or the HITL/elicit flow depends on stays in `core`
  regardless of usage. See `packages/server/src/mcp/tool-profiles.ts`'s module
  comment for the full accounting, including the caution that a documented history
  of plugin-bridge integration bugs (companion routes 404ing, a wrong plugin-id
  mapping) means zero calls to that family cannot be read as zero want.

A tool `core` hides is not silently missing: `find_capability` discloses a
profile-hidden match by name and count when your query matches one;
`describe_capability`/`call_capability` on one by name both answer a
`capability_hidden` error naming the config key, never a bare "not found" and
never a silent dispatch; `inspect_visibility` reports `disabled_by_profile`.
`toolFacade.profile` is the default (`"full"`) unless you set it — no migration
needed.

## Tool tags

Every tool carries a set of tags, and `toolVisibility.hiddenTags` / `disabledTags` act on them.
Naming a tag in `hiddenTags` drops its tools from `tools/list`, `find_capability`, the
`obsidian-tc://catalog` resource and the domain meta-tools while leaving them callable by name;
naming it in `disabledTags` also rejects the call, as if the tool were never registered. Each
tool's page in the [Tool Catalog](/tools/tool-catalog/) lists its tags, and `describe_capability`
returns them as `tags`.

Most tags are **derived** at registration from what the tool already declares, so they cannot
drift: a tool's scopes say whether it writes, its destructive and confirmation flags say whether
it can destroy data, and its facade domain gives its `domain:` tag. A few facts no other field
carries are **declared** on the tool definition. Registration refuses a tag outside this
vocabulary, a derived tag written by hand, and a declaration the derivation already makes.

| Tag | Source | Meaning |
| --- | --- | --- |
| `read-only` | derived | Does not mutate the vault: no write, delete, bulk or execute scope, and not destructive. The same test as the read-only gate and the MCP `readOnlyHint`. |
| `writes` | derived | Mutates the vault. The complement of `read-only`. |
| `destructive` | derived | Can destroy data, always or on some calls (the MCP `destructiveHint`). |
| `hitl` | derived | Needs a human confirmation token, always or when a call crosses a boundary. |
| `bulk` | derived | Holds a `bulk:*` scope: one call changes many notes. |
| `admin` | derived | Holds an `admin:*` scope: administers the server, its vaults, ACLs, config or metrics. It may change server state without modifying notes, so it can also be `read-only`. |
| `domain:<name>` | derived | Belongs to that facade domain, for example `domain:git` or `domain:notes`. |
| `plugin-bridge` | derived and declared | Needs the Obsidian companion plugin, so a live Obsidian session. Derived from a scope that names a plugin; declared for the few bridge tools whose scope is a generic vault scope. |
| `external-network` | declared | The tool's handler may send query or note text to a service outside the server process: a hosted embedding provider, or a cloud sync plugin. Indexing that runs in the background after a write is not attributed to the tool that triggered it. |
| `client-sampling` | declared | The tool asks the calling client's own model to run a completion (MCP sampling) and sends it note text the caller may already read. The client decides whether to prompt its user and whose tokens pay for it. The tool has a non-sampling fallback, so `disabledTags: ["client-sampling"]` removes it only for deployments that want no sampling request at all. |
| `experiential` | declared | Reads or writes the derived work-memory plane. |
| `verdict` | declared | A verdict verb: its calls are recorded as verdicts, never as evidence for later retrieval. |
| `knowledge` | declared | Part of the knowledge-retrieval surface. |
| `search` | declared | Retrieves notes or chunks by query. |
| `docs` | declared | Reads the external vendor-docs corpus. |
| `links` | declared | Reads the link graph. |
| `graph` | declared | Computes graph analytics over the link graph. |
| `provenance` | declared | Reports where an answer came from. |
| `diagnostics` | declared | Explains or audits retrieval behaviour. |

For example, `hiddenTags: ["destructive"]` keeps every tool that can delete or overwrite out of a
client's discovery, and `disabledTags: ["external-network"]` makes a deployment that must not call
a hosted embedding provider refuse those tools outright.

## Domains

| Group | Domains | Examples |
| --- | --- | --- |
| **Notes & metadata** (6 tools `full`-only) | notes, frontmatter, properties, tags, links, headings | `read_note`, `write_note`, `patch_note`, `update_frontmatter`, `get_backlinks`; graph analysis is `full`-only: `graph_centrality`, `graph_communities`, `suggest_links`, `find_link_cycles`, `prune_hub_links`; `suggest_tags` (client-sampled tag suggestions) is `full`-only too |
| **Search & retrieval** | text search, DQL, vector / hybrid search, embeddings | `search_vault`, `search_dql`, `search_semantic` |
| **Structured formats** (`full`-only) | Bases, Canvas, periodic notes, bookmarks, outlines | `read_base`, `update_canvas`, `create_periodic_note`, `list_bookmarks` |
| **Plugin bridges** (`full`-only) | Dataview, Templater, OCR, command execution, tasks, workspace | `eval_dataview_field`, `execute_template`, `execute_command`, `list_tasks` |
| **Memory & capture** | memory store, capture queue, workspace traces, PLUR proxy | `add_observation`, `enqueue_capture`, `plur_recall` |
| **Knowledge & context** | GraphRAG, composite context, reflection, red-team challenge | `vault_graph_search`, `vault_context`, `reflect`, `knowledge_challenge` |
| **Work memory (experiential)** | quarantined agent-episode store with an eligibility-gated reader contract | `work_search`, `work_episodes`, `work_forget`, `record_retrieval_feedback` |
| **Git & sync bridges** (`full`-only) | Obsidian Git (commit is HITL-floored), Remotely Save backup signal | `git_status`, `git_diff`, `git_commit`, `remotely_save_status` |
| **Bulk & URI** | bulk note create / move / set-property, `obsidian://` URI generation, plus `bundle_files`/`bundle_folder` (filesystem-only, kept in `core`) | `bulk_create_notes`, `bulk_move_notes`, `bulk_set_property`, `generate_uri`, `bundle_folder` |
| **Server admin** | health, config, ACL, metrics introspection | `server_health`, `get_server_config`, `inspect_acl`, `get_metrics` |

See the [Tool Catalog](/tools/tool-catalog/) for the per-tool Profile column (generated from
`tool-profiles.ts`, the single source of truth this table's `full`-only markers also read from).

## Response format

Tools that return more than an acknowledgement take an optional `response_format`:
`concise` returns only the high-signal fields, `detailed` returns the full payload.
The format is resolved in this order: an explicit `response_format` on the call, then
the legacy `verbosity` alias (`terse` is `concise`, `full` is `detailed`), then the
operator default `tools.defaults.responseFormat`, then `detailed`. The shipped default
is `detailed`, so output is unchanged until a call or the config opts in.

Supported today: `read_note`, `read_notes`, `get_active_file`, `write_note`, `append_note`,
`patch_note`, `update_frontmatter` (and the `update_active_file`, `append_active_file` and
`patch_active_file` tools, which pass the parameter to the tool they delegate to),
`read_frontmatter`, `find_notes_by_property`, `list_notes`, `get_outgoing_links`,
`get_backlinks`, `find_unresolved_links`, `read_resources`, the search tools
(`search_text`, `search_regex`, `search_semantic`, `search_jsonlogic`, `search_vault`) and
`note_quality_report`. A concise write acknowledgement is `{ vault, path, content_hash }`;
a concise `read_note` is the note body without frontmatter (or just the requested section).
Other concise shapes: `read_frontmatter` omits `has_frontmatter` (it is `frontmatter !== null`);
`list_notes` returns `{ vault, notes: [{ path }], next_cursor }`; `get_backlinks` returns
`{ source_path, line }` per backlink; `get_outgoing_links` returns `{ target, line, resolved }`
per link plus `heading`, `target_path` and `candidates` when they are set; `read_resources`
returns `{ ok, uri, text }` per item with the note body only.

`resources/read` takes no parameters, so only the config default applies to it: with
`tools.defaults.responseFormat: "concise"` it returns the note body without its frontmatter
block (the URI and MIME type are kept). The scope, vault binding, folder ACL, size ceiling
(judged on the raw note) and cache hints are the same in both formats. `find_orphans` already
returns bare paths, so it takes no parameter.

The listing, graph, memory and episode tools also take it: `list_attachments`,
`list_periodic_notes`, `list_snapshots`, `list_capture_queue`, `list_goals`, `search_and_read`,
`vault_graph_search`, `knowledge_search`, `get_entity`, `query_entity_graph`,
`get_session_traces`, `session_bootstrap`, `work_episodes`, `work_episode_chain`,
`work_search`, `gap_report`, `rewrite_link` and `prune_hub_links`. Their concise shapes keep
what a caller acts on and drop the rest:

- `list_attachments` returns `{ path }` per file plus `reference_count` when requested (no size,
  mtime, MIME type, folder echoes or `total_returned`); `list_periodic_notes` returns
  `{ date, path }` per item (no period or mtime); `list_snapshots` returns `{ id, op, created_at }`
  per snapshot (no `content_hash`, size or total); `list_goals` returns `{ id, text, status }`
  plus `target_date` and `closed_at` when set.
- `search_and_read` returns `{ path, rank, score, body, content_hash }` per note, without
  frontmatter (note mode) or `chunk_id` (section mode). `size_bytes` and `truncated` appear only on
  a note that was cut to its share, since there they say how much to fetch with `read_note`.
- `vault_graph_search` and `knowledge_search` keep `chunk_id`, `path`, `content`, `rerank_score`,
  `vault` and `changed_since_d` per hit, and drop the retrieval provenance (arm, hop, edge, seed)
  and the `route` and `coverage` blocks. `vault_graph_search` also keeps `mode_used`,
  `failed_variants` and `failed_vaults`.
- `get_entity` and `query_entity_graph` return each observation as `{ text, key }`, plus
  `valid_to` and `superseded_by` when the fact is no longer current; they omit `valid_from`,
  `created_at`, `updated_at`, `as_of`, the hop-by-hop `path` and a null `vault_path`.
- `list_capture_queue` omits null and empty item fields; `get_session_traces` drops `args_hash` and
  `caller`; `session_bootstrap` drops each loaded note's parsed frontmatter (the note text in
  `content` is whole).
- `work_episodes`, `work_episode_chain` and `work_search` keep id, time, session, tool, status,
  error code, summary, `trust`, `eligibility`, a true `blocked` and the amendment link, and drop
  vault, caller, channel, episode type, duration, result size and every null or empty field.
  `gap_report` keeps `{ id, query, top_score, gap }` per query (no `results` or `nearest`) and the
  totals.
- `rewrite_link` and `prune_hub_links` on a real run return the counts (`notes_changed`,
  `links_rewritten`, `removed_count`) and `content_hash` without the per-note change list,
  `removed[]` and `prev_hash`. A dry run keeps them, because they are the preview and the inputs
  of the confirming call.

The knowledge-read, link-health, bundle and canvas-reader tools also take it: `vault_context`,
`explain_answer`, `diagnose_retrieval`, `knowledge_get_critical`, `audit_provenance`,
`vault_health_score`, `suggest_links`, `suggest_tags`, `bundle_files`, `bundle_folder` and
`read_canvas` (and `get_provenance`, which drops the host, the full path list, the record hash and
the machine field).

- `vault_context` keeps the packed notes with `{ chunk_id, content, score }` per chunk, the
  syntheses, the open contradictions, the lessons as `{ chunk_id, path, excerpt }`, the episodes,
  `diff_since` and the prefetch pair; it drops the route signals, the query source, the budget and
  stats blocks, and each chunk's `source` and `hop`.
- `explain_answer` keeps each link's chunk, path, whether the chunk still resolves, the citation
  verdict and score and the correlation, plus `caveat` and `citation_pass` (they stop an unjudged
  chain reading as an unused one); it drops `summary` and each link's retrieval echo.
  `diagnose_retrieval` returns `{ vault, returned, dropped_at, summary }`.
  `knowledge_get_critical` returns `{ path, title, category, source }` per document.
- `audit_provenance` drops the `field` echo, `with_provenance` and the `by_folder` breakdown;
  `vault_health_score` drops `total_links` and the per-penalty `breakdown`; `suggest_links`
  returns `{ path, score }` per suggestion; `suggest_tags` returns `source` and the suggestions.
- `bundle_files` and `bundle_folder` keep the bundle text, `file_count`, `truncated` and (per
  tool) the resume `cursor` or `missing_paths`; they drop the per-file list (each path already
  heads its block in the bundle), `total_bytes` and the `root` echo. `read_canvas` keeps what a
  node says and what an edge joins, and drops the layout (geometry, background, edge sides and
  ends) and the two counts.

Ten more reads and reports take it: `find_notes_by_tag`, `get_note_tags`, `read_property`,
`get_periodic_note`, `find_or_create_periodic_note`, `index_vault`, `inspect_visibility`,
`get_server_config`, `bulk_create_notes` and `bulk_set_property`.

- `find_notes_by_tag` returns `{ path }` per match plus `truncated` (it says the list is cut), and
  drops the matched tags and `total`; `get_note_tags` returns only the combined `all` set, not the
  frontmatter and inline split; `read_property` returns `value` and `found` without the `key` and
  `nested` echoes.
- `get_periodic_note` and `find_or_create_periodic_note` keep the date, path, `exists` or
  `created`, the note `content` and any `redactions`, and drop the `period` echo and the parsed
  `frontmatter` (the content already carries the block).
- `index_vault` keeps the note and chunk totals and every failure, skip and degradation signal
  (`secrets_skipped`, `notes_embed_failed`, `chunks_dedup_unresolved`, `embed_batch_rejections`,
  `notes_stale_skipped`, `notes_epoch_stale_skipped`, `notes_frontmatter_failed` with its list, `vec_enabled`, `fts_enabled`),
  and drops the bookkeeping counters (unchanged chunks, edge and upsert/delete totals, reused
  dedup chunks, model, dimensions).
- `inspect_visibility` returns `{ name, visibility, reason }` per tool, plus `matched_tag` and
  `missing_scopes` when the verdict has one (the rule that decided it); it drops `domain`,
  `required_scopes` and `tags`. The `summary` still covers the whole surface.
  `get_server_config` keeps the auth mode, `read_only`, the embeddings provider, the limits, the
  limiter backend and failure policy, the governor ceiling and the detected plugins, and drops the
  per-class throttle tiers, the observability toggles and the retrieval-defaults report.
- `bulk_create_notes` and `bulk_set_property` keep `succeeded`, `failed` and every per-item
  outcome (path, `ok`, hash, `prev_value`, `redactions`, error), and drop `processed`,
  `duration_ms` and each created item's `mode_used`.

Concise never drops a safety signal: a non-empty `quality_warning`, a `poison_assessment`
other than `none` (`list_capture_queue` always keeps it), `redactions`, a redacted `to_target`
echo from `rewrite_link`, the trust and eligibility of a work episode, and a `patch_note` call's
removed-line and removed-byte counts are kept, and errors are never shaped. Because `concise`
omits fields, the advertised output schema marks those fields optional; a `detailed` result
always carries them.

### Tools with no `response_format`

Each of these was reviewed and takes no parameter, because there is nothing a caller could spare:

| Tool | Why |
| --- | --- |
| `list_tags`, `list_properties` | One `{ name, count }`-style row per entry: already minimal. |
| `list_vaults`, `list_kanban_boards` | One minimal row per entry. |
| `list_workspaces` | Workspace names only. |
| `list_bookmarks` | The item tree and the compare-and-swap `content_hash` are the payload. |
| `list_commands`, `list_quickadd_actions`, `list_templates` | Opaque plugin passthrough: `{ id, name }`, `{ name, type }` or `{ path, name }` per entry. |
| `list_tasks` | Every field is task data, and empty optional fields are already omitted. |
| `list_contradictions` | The rationale is the product. |
| `episode_stats` | Aggregate counts only. |
| `find_orphans` | Bare paths already. |
| `plur_get`, `plur_recall`, `plur_recall_hybrid`, `plur_similarity_search` | Read-only proxies of an external payload this server does not own. |
| `reflect`, `knowledge_challenge` | The synthesized answer or verdict and its evidence are the product; the rest is a few short fields. |
| `find_link_cycles`, `graph_centrality`, `graph_path_between` | The path lists, ranked rows or hop chain are the payload; the rest is a count or a presence flag. |
| `get_link_strength` | One scored row: every field is a component of the score. |
| `graph_communities` | The communities are the payload; `modularity`, `meaningful` and the chance warning are safety signals. |
| `git_status`, `git_diff`, `git_log`, `git_stage`, `git_commit` | Opaque Obsidian Git companion passthrough or acknowledgement. `git_commit` also returns any `stamped_trailers`, which are provenance a caller must see. |
| `ocr_attachment`, `ocr_bulk` | Opaque Text Extractor passthrough: the extracted text is the payload. |
| `read_base`, `query_base`, `read_kanban_board`, `query_canvas` | The parsed document, resolved rows, columns and cards or matching nodes are the payload; `content_hash` is the compare-and-swap token. |
| `create_base`, `update_base`, `create_canvas`, `update_canvas`, `add_kanban_card`, `move_kanban_card` | Write acknowledgements: counts, any deprecation notice and the compare-and-swap hashes the next write needs. |
| `read_excalidraw`, `create_excalidraw`, `update_excalidraw` | `read_excalidraw` already selects its payload with `format`; the rest is opaque Excalidraw companion JSON or an acknowledgement. |
| `format_table`, `insert_table_column`, `insert_table_row`, `sort_table_by_column` | Write acknowledgements: row and column counts, the compare-and-swap hashes and the `redactions` signal. |
| `eval_dataview_field`, `validate_dql`, `search_dql`, `query_datacore` | Opaque Dataview or Datacore companion passthrough: the value, AST, rows or parse-error location is the payload (`search_dql` also returns `note_paths`, which index the matched notes). |
| `makemd_list_spaces`, `makemd_query`, `search_omnisearch` | Opaque MakeMD or Omnisearch companion passthrough: the items or hits are the payload. |
| `remotely_save_status`, `remotely_save_trigger` | Opaque Remotely Save companion passthrough or acknowledgement. |
| `create_entity`, `add_observation`, `link_entities`, `unlink_entities`, `rename_entity`, `delete_entity` | Write acknowledgements: entity ids, status, the edge identity, counts (observations, relations removed, neighbours re-materialized), timestamps and the `redactions` signal. |
| `start_session`, `end_session`, `enqueue_capture`, `commit_capture` | Write acknowledgements: ids, paths, event count and duration, the compare-and-swap hash and the `redactions` signal. |
| `set_goal`, `close_goal`, `record_retrieval_feedback`, `work_result`, `work_forget` | Write acknowledgements: ids, the new state and how many retrievals were stamped, demoted or forgotten (`updated: 0` carries a `reason`). |
| `session_rerun` | The per-record verdicts and divergences are the report; the summary counts qualify them. |
| `add_tag`, `remove_tag` | Write acknowledgements: the removed count and the compare-and-swap hashes the next write needs. |
| `copy_note`, `move_note`, `delete_note`, `delete_active_file`, `restore_note`, `snapshot_note` | Write acknowledgements: the destination or snapshot id, the content hashes, where a deleted or overwritten file was trashed, `backlinks_updated` (a blast-radius count) and the `redactions` signal. |
| `bulk_move_notes` | Every per-move row is a blast-radius count or an error, and `hidden_backlinks` is a safety flag. |
| `note_exists` | One boolean and a type. |
| `read_snapshot` | The stored content is the payload; the rest is four short scalars. |
| `read_metadata_fields`, `tasks_filter`, `resolve_daily_note` | Opaque companion passthrough: the fields, the matched tasks (ACL-filtered here) or the resolved path is the payload. |
| `execute_command`, `execute_template`, `trigger_quickadd`, `show_file_in_obsidian` | Opaque companion passthrough or acknowledgement: the plugin's own result, whose effects this server cannot see. `execute_template` also returns any `stamped_trailers`, which are provenance a caller must see. |
| `get_attachment` | The base64 bytes are the payload; MIME type, size and encoding describe them. |
| `write_attachment`, `move_attachment`, `delete_attachment` | Write acknowledgements: the path, size and hash, where a replaced or deleted file was trashed, `references_updated` (a blast-radius count) and, for a delete, the notes that still reference it. |
| `add_bookmark`, `remove_bookmark`, `open_workspace`, `save_workspace` | Write acknowledgements, or the layout itself for `open_workspace`: counts and the compare-and-swap hash the next write needs. |
| `create_periodic_note`, `append_to_periodic_note` | Write acknowledgements: the path, the bytes appended, whether the template expanded and the `redactions` signal. |
| `update_task` | Write acknowledgement: the before and after task state, the compare-and-swap hash and the `redactions` signal. |
| `generate_uri` | One URI. |
| `add_vault`, `reload_vault`, `reset_vault_cache`, `refresh_plugin_capabilities` | Acknowledgements: the vault id and times, the rows dropped (the blast radius) or the capability diff, which is the payload. |
| `get_vault` | One vault's configuration; `read_only` and the ACL path lists are safety signals and the rest is two short blocks. |
| `get_index_status`, `server_health` | Every field is a health signal (reconcile state, write failures, vec and fts, the job queue, leader role, facade and telemetry). |
| `get_metrics`, `inspect_acl` | The metric rows, or the one allow or deny verdict with its rule, are the payload. |

Every registered tool is in exactly one of the two groups, the tools that take `response_format`
and the table above. A test fails when a newly registered tool is in neither, so the decision
cannot be skipped.

## Degradation & errors

A tool that needs an unavailable capability (a missing plugin, an unconfigured
embedding provider) returns a typed error from the shared `ObsidianTcError`
taxonomy (e.g. `plugin_missing`, `embedding_provider_error`) with a `retryable`
flag and a bounded `recovery` hint naming the next step — it never throws an
opaque failure. At the MCP boundary a dispatch failure
surfaces as a **Tool Execution Error** (`isError: true` with human-readable text
plus the structured error as `structuredContent`), so a model can self-correct
rather than seeing a protocol error.

:::note
Per-tool reference pages auto-generated from the live `ToolRegistry` and its Zod
schemas are a deferred follow-up. This page is the curated overview.
:::
