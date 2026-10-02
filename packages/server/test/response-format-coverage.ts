// GH #1027: the decision record for `response_format`. Every registered tool is exactly one of
//   1. response_format-aware (its input schema advertises the parameter; derived live, not listed),
//   2. EXEMPT_FROM_RESPONSE_FORMAT: reviewed, and concise would drop nothing a caller can spare.
// response_format-coverage.test.ts enforces the partition both ways, so a new tool cannot skip the
// decision: it either spreads `ResponseFormatInput` into its input schema or is listed here with a
// reason. There is no third "not yet decided" list any more (part 4b of #1027 emptied it).
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
  commit_wiki_page:
    "a short receipt of the writes plus the problems found: every field is a safety signal",
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
  // part 4b: reviewed with the memory, goal and session writes, the note, attachment and tag
  // operations, the workspace and plugin actions, and vault/index/server administration
  add_observation: "write acknowledgement: entity id, observation count, timestamps and redactions",
  update_observation:
    "write acknowledgement: the closed and replacement observation ids, observation count and redactions",
  close_goal: "write acknowledgement: the goal id, its closed state and the closing time",
  commit_capture:
    "write acknowledgement: the committed path, its compare-and-swap hash and the redactions signal",
  create_entity:
    "write acknowledgement: entity id, status, materialization and the redactions signal",
  delete_entity:
    "write acknowledgement: what was deleted, the relations removed with it and where it was trashed",
  end_session: "write acknowledgement: the session id, event count and duration",
  enqueue_capture:
    "write acknowledgement: the capture id and the redactions signal the caller must see",
  link_entities: "write acknowledgement: the edge identity, whether it existed and redactions",
  record_retrieval_feedback:
    "write acknowledgement: how many retrievals were stamped, and why none were",
  rename_entity:
    "write acknowledgement: the entity, and how many neighbour notes were re-materialized",
  session_rerun:
    "the per-record verdicts and divergences are the report; the summary counts qualify them",
  set_goal: "write acknowledgement: the goal id, its state and the redactions signal",
  start_session: "write acknowledgement: the session id, the trace path and the redactions signal",
  unlink_entities: "write acknowledgement: the edge identity and whether it was removed",
  work_forget: "write acknowledgement: the episode id and whether it was forgotten",
  work_result: "write acknowledgement: how many retrievals were stamped and demoted",
  add_tag: "write acknowledgement: the compare-and-swap hashes the next write needs",
  remove_tag:
    "write acknowledgement: the removed count and the compare-and-swap hashes the next write needs",
  bulk_move_notes:
    "every per-move row is a blast-radius count or an error, and hidden_backlinks is a safety flag",
  copy_note: "write acknowledgement: the destination, its hash and whether it overwrote",
  delete_note: "write acknowledgement: where it was trashed and the hash it had",
  move_note:
    "write acknowledgement: the destination hash and the backlinks_updated blast-radius counts",
  note_exists: "one boolean and a type: nothing to drop",
  restore_note:
    "write acknowledgement: the compare-and-swap hashes, the snapshot restored and the redactions signal",
  snapshot_note: "write acknowledgement: the snapshot id and the content hash",
  read_snapshot: "the stored content is the payload; the other fields are four short scalars",
  read_metadata_fields: "opaque Metadata Menu passthrough: the per-field values are the payload",
  delete_active_file:
    "write acknowledgement, the same shape as delete_note: where it was trashed and the hash it had",
  delete_attachment:
    "write acknowledgement: where it was trashed and the notes that still reference it (a dangling-link signal)",
  get_attachment: "the base64 bytes are the payload; mime, size and encoding describe them",
  move_attachment:
    "write acknowledgement: the destination and the references-updated blast-radius count",
  write_attachment: "write acknowledgement: the path, size and whether it overwrote",
  add_bookmark: "write acknowledgement: the compare-and-swap hash the next write needs",
  remove_bookmark: "write acknowledgement: the compare-and-swap hash the next write needs",
  open_workspace: "the layout is the payload; active and the compare-and-swap hash qualify it",
  save_workspace: "write acknowledgement: the name, count and the compare-and-swap hash",
  append_to_periodic_note:
    "write acknowledgement: the path, the bytes appended and the redactions signal",
  create_periodic_note:
    "write acknowledgement: the path, whether the template expanded and the redactions signal",
  resolve_daily_note: "opaque Daily Notes companion passthrough: the resolved path is the payload",
  execute_command:
    "opaque companion passthrough: the command id plus the plugin's own result, whose effects this server cannot see",
  execute_template:
    "opaque Templater passthrough: the plugin's own result, plus any stamped_trailers provenance a caller must see",
  trigger_quickadd:
    "opaque QuickAdd companion passthrough: the action name plus the plugin's result",
  tasks_filter:
    "opaque Tasks companion passthrough: the matched tasks are the payload, ACL-filtered here",
  update_task:
    "write acknowledgement: the before and after task state, the compare-and-swap hash and the redactions signal",
  generate_uri: "one URI: the payload",
  show_file_in_obsidian: "acknowledgement: the open method, or the reason it was unavailable",
  add_vault: "write acknowledgement: the registered vault id, path and index summary",
  get_vault:
    "one vault's configuration; read_only and the ACL path lists are safety signals and the rest is two short blocks",
  reload_vault: "write acknowledgement: the vault id and the reload time",
  reset_vault_cache: "write acknowledgement: the rows dropped, which is the blast radius",
  refresh_plugin_capabilities:
    "the diff of what changed is the payload; an empty diff is already three scalars",
  get_index_status:
    "every field is an index-health signal (reconcile state, write failures, vec/fts)",
  get_metrics: "the metric rows are the payload",
  inspect_acl: "one allow/deny verdict with its rule: every field is part of the decision",
  server_health:
    "every field is a health signal (index, job queue, leader role, facade, telemetry); the always-present ones are non-identifying scalars",
};
