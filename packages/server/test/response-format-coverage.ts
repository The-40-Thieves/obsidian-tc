// GH #1027: the decision record for `response_format`. Every registered tool is exactly one of
//   1. response_format-aware (its input schema advertises the parameter; derived live, not listed),
//   2. EXEMPT_FROM_RESPONSE_FORMAT: reviewed, and concise would drop nothing a caller can spare,
//   3. NOT_YET_COVERED_BY_RESPONSE_FORMAT: not reviewed yet, so still detailed-only.
// response-format-coverage.test.ts enforces the partition, so a new tool cannot skip the decision.
// Moving a tool from list 3 to "aware" means deleting its name here, nothing else.
//
// The exempt reasons are mirrored in the "Response format" section of the user docs.

export const EXEMPT_FROM_RESPONSE_FORMAT: Readonly<Record<string, string>> = {
  list_tags: "one {tag, count} row per tag: already minimal",
  list_properties: "one {key, type, count} row per property: already minimal",
  list_vaults: "one minimal row per vault: nothing to drop",
  list_workspaces: "a list of workspace names only: nothing to drop",
  list_kanban_boards: "one minimal row per board: nothing to drop",
  list_bookmarks: "the items tree and the CAS content_hash are the payload",
  list_commands: "opaque plugin passthrough, {id, name} per command",
  list_quickadd_actions: "opaque plugin passthrough, {name, type} per action",
  list_templates: "opaque plugin passthrough, {path, name} per template",
  list_tasks: "every field is task data; optional fields are already omitted when empty",
  list_contradictions: "the rationale is the product",
  episode_stats: "aggregate counts only",
  find_orphans: "bare paths already",
  plur_get: "read-only proxy of an external payload we do not own",
  plur_recall: "read-only proxy of an external payload we do not own",
  plur_recall_hybrid: "read-only proxy of an external payload we do not own",
  plur_similarity_search: "read-only proxy of an external payload we do not own",
  // part 4a: reviewed with the knowledge, structured-document, bundle, OCR and Git domains
  reflect:
    "the synthesized answer and its cited sources are the product; the rest is a few short fields",
  knowledge_challenge:
    "the verdict and its evidence are the product; the rest is two counts and the model name",
  find_link_cycles: "ordered path lists are the payload; total is their count",
  get_link_strength: "one scored row: every field is a component of the score",
  graph_centrality: "ranked {path, score} rows are the payload; the rest is two aggregate counts",
  graph_communities:
    "the communities are the payload; modularity, meaningful and the chance warning are safety signals",
  graph_path_between: "the hop chain and the presence flags are the answer",
  git_status: "opaque Obsidian Git companion passthrough: this server does not own the payload",
  git_diff: "opaque Obsidian Git companion passthrough: the unified diff is the payload",
  git_log: "opaque Obsidian Git companion passthrough: hash, message, author and date per commit",
  git_stage: "opaque Obsidian Git companion acknowledgement",
  git_commit:
    "opaque Obsidian Git companion acknowledgement; any stamped_trailers are provenance a caller must see",
  ocr_attachment: "opaque Text Extractor passthrough: the extracted text is the payload",
  ocr_bulk: "opaque Text Extractor passthrough: the per-file extracted text is the payload",
  read_base: "the parsed base document is the payload; content_hash is the compare-and-swap token",
  query_base: "the resolved rows are the payload; view_used and total qualify them",
  create_base:
    "write acknowledgement: the compare-and-swap hash and any deprecation notice a caller must see",
  update_base:
    "write acknowledgement: applied counts and the compare-and-swap hashes the next write needs",
  create_canvas: "write acknowledgement: counts and the compare-and-swap hash",
  update_canvas:
    "write acknowledgement: applied counts and the compare-and-swap hashes the next write needs",
  query_canvas: "the matching nodes are the payload; errors name the canvases that did not parse",
  read_excalidraw:
    "already selects its payload with `format` (elements, text or both); the rest is opaque companion JSON",
  create_excalidraw: "opaque Excalidraw companion acknowledgement",
  update_excalidraw: "opaque Excalidraw companion acknowledgement",
  read_kanban_board:
    "every column and card is the payload; content_hash is the compare-and-swap token",
  add_kanban_card: "write acknowledgement: the compare-and-swap hashes the next write needs",
  move_kanban_card: "write acknowledgement: the compare-and-swap hashes the next write needs",
  format_table:
    "write acknowledgement: row and column counts, the compare-and-swap hashes and the redactions signal",
  insert_table_column:
    "write acknowledgement: row and column counts, the compare-and-swap hashes and the redactions signal",
  insert_table_row:
    "write acknowledgement: row and column counts, the compare-and-swap hashes and the redactions signal",
  sort_table_by_column:
    "write acknowledgement: row and column counts, the compare-and-swap hashes and the redactions signal",
  eval_dataview_field: "opaque Dataview companion passthrough: the evaluated value and its type",
  search_dql: "the Dataview rows are the payload; note_paths indexes the matched notes",
  validate_dql: "opaque Dataview companion passthrough: the AST or the parse-error location",
  query_datacore: "opaque Datacore companion passthrough",
  makemd_list_spaces: "opaque MakeMD companion passthrough",
  makemd_query: "opaque MakeMD companion passthrough: the items are the payload",
  search_omnisearch: "opaque Omnisearch companion passthrough: the hits are the payload",
  remotely_save_status: "opaque Remotely Save companion passthrough",
  remotely_save_trigger: "opaque Remotely Save companion acknowledgement",
};

/** Reviewed in no part of #1027 yet. Each part of the series shrinks this list; none grows it
 *  except a newly registered tool that has not been decided. */
export const NOT_YET_COVERED_BY_RESPONSE_FORMAT: readonly string[] = [
  // memory, goal, session and episode writes and acks
  "add_observation",
  "close_goal",
  "commit_capture",
  "create_entity",
  "delete_entity",
  "end_session",
  "enqueue_capture",
  "link_entities",
  "record_retrieval_feedback",
  "rename_entity",
  "session_rerun",
  "set_goal",
  "start_session",
  "unlink_entities",
  "work_forget",
  "work_result",
  // note, attachment, tag, property and snapshot operations
  "add_tag",
  "remove_tag",
  "bulk_create_notes",
  "bulk_move_notes",
  "bulk_set_property",
  "copy_note",
  "delete_note",
  "move_note",
  "note_exists",
  "restore_note",
  "snapshot_note",
  "read_snapshot",
  "find_notes_by_tag",
  "get_note_tags",
  "read_property",
  "read_metadata_fields",
  "delete_active_file",
  "delete_attachment",
  "get_attachment",
  "move_attachment",
  "write_attachment",
  // bookmarks, workspaces, periodic notes, templates, tasks and other plugin actions
  "add_bookmark",
  "remove_bookmark",
  "open_workspace",
  "save_workspace",
  "append_to_periodic_note",
  "create_periodic_note",
  "find_or_create_periodic_note",
  "get_periodic_note",
  "resolve_daily_note",
  "execute_command",
  "execute_template",
  "trigger_quickadd",
  "tasks_filter",
  "update_task",
  "generate_uri",
  "show_file_in_obsidian",
  // vault registry, index and server administration
  "add_vault",
  "get_vault",
  "index_vault",
  "reload_vault",
  "reset_vault_cache",
  "refresh_plugin_capabilities",
  "get_index_status",
  "get_metrics",
  "get_server_config",
  "inspect_acl",
  "inspect_visibility",
  "server_health",
];
