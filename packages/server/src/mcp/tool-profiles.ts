// THE-1131: the single source of truth for `toolFacade.profile`. Every gate that needs to know
// "which tools does the core profile hide" (server-runtime wiring, docgen stats, the tool-count
// tests, doctor/health reporting, check-version-coherence.mjs) imports NON_CORE_TOOL_NAMES from
// here rather than keeping a second copy — the same drift class registered-tool-count.ts's own
// module comment describes for REGISTERED_TOOL_COUNT.
//
// `toolFacade.profile` defaults to `"full"` — REGISTRATION AND VISIBILITY ARE UNCHANGED FROM
// TODAY. `"core"` is opt-in: a curated, SMALLER surface an operator can switch to. This is
// deliberate, not a placeholder for a future default flip. ADR 0006 (docs/adr/) already commits to
// "every capability remains callable" as the shipped default, and flipping that default needs its
// own evidence-gated decision (see docs/adr/, and the "Tool profile" section of
// docs/src/content/docs/tools/index.md) — not a side effect of adding the *mechanism*. Under
// `"core"` a tool is still REGISTERED (registry.list() is always all 163; see
// registered-tool-count.ts) — only its dispatchability/visibility changes, and it stays
// discoverable: find_capability and the obsidian-tc://catalog resource surface a core-hidden match
// with its disclosable reason rather than pretending it does not exist (mcp/server.ts,
// mcp/resources.ts).
//
// Evidence, corrected after a review round that found the first draft overstated it:
//
// - Five M1 graph-analysis tools — the ONLY individually-confirmed-zero-call tools in the evidence
//   base (GH #877, `episode_stats` over 4,787 recorded calls against REGISTERED_TOOL_COUNT = 163):
//   `graph_centrality`, `graph_communities`, `suggest_links`, `find_link_cycles`,
//   `prune_hub_links`. Nothing else in this registry (triad, M5/M7/M8, catalog discovery,
//   health/admin, HITL/elicit) depends on them. The rest of M1 (`list_notes`, `read_note`,
//   `read_notes`, `write_note`, `patch_note` and the remaining links/tags/frontmatter/snapshot
//   tools) stays in `core`: it is the single most-used family in #877's own numbers.
// - M3 (structured documents: canvas, bases, kanban, periodic notes, bookmarks, attachments,
//   tables), 31 tools — curated on a STRUCTURAL criterion, not usage: #877 gives no evidence either
//   way for any M3 tool (none appear among its used tools, none are named as zero-call examples
//   either). Left out of `core` as a smaller-surface curation choice pending real usage data, not
//   because usage is known to be zero.
// - M4 plugin-bridge minus `bundle_files`/`bundle_folder` (30 tools: Excalidraw, MakeMD, Remotely
//   Save, OCR, git, Templater, QuickAdd, Dataview, Datacore, Omnisearch, Metadata Menu, command
//   palette, `resolve_daily_note`, `tasks_filter`) — curated on a DEPENDENCY criterion: every tool
//   here proxies to a live companion plugin/app (`openBridge`/`openCompanionBridge` in
//   tools/m4/shared.ts) and degrades to `plugin_missing`/`plugin_unreachable`/
//   `requires_live_obsidian` when it is absent, so a `core` profile aimed at a minimal-dependency
//   default surface excludes the whole family. This is NOT a usage claim — #877 names no M4 tool
//   specifically, and a prior draft of this file incorrectly asserted it did. Three M4 tools do
//   NOT degrade this way and are kept in `M4_PLUGIN_BRIDGE` below anyway, because the criterion is
//   the family's overall shape, not a per-tool audit: `list_tasks`/`update_task` are
//   filesystem-only (tasks-tools.ts's own header comment — only `tasks_filter` proxies the Tasks
//   plugin's DSL), and `refresh_plugin_capabilities` is the capability-probe tool itself, not
//   something the probe gates. `execute_command`/`list_commands` gate on the companion but have an
//   LRA-native fallback (GH #155) that answers even without one, so "requires a live Obsidian +
//   LRA" is more accurate for them than "requires the full companion".
//   `bundle_files`/`bundle_folder` moved OUT of this set (into core) after review: both are pure
//   filesystem (no bridge-gate call at all — bundle-tools.ts) and `bundle_folder` has direct,
//   unsolicited usage evidence (GH #879: "the right tool and it changed how I did this work",
//   filed by the same reporter as #877's usage report).
//
// A caution on absence-of-evidence for this specific family: GH #153 and #152 (both v1.3.6,
// pre-dating #877's v1.23.5 measurement) document that the plugin-bridge companion transport was
// completely broken (every route 404ing; a wrong plugin-id mapping) before those bugs were fixed —
// a concrete instance of #877's own thesis, "the unused 97 are not unwanted, they are unfound":
// zero calls to a family does not by itself mean zero want, especially one with a documented history
// of integration bugs blocking it outright. That is the reasoning for curating M3/M4 on their
// structural shape rather than asserting #877 measured them as unwanted.
const M3_STRUCTURED_DOCUMENTS = [
  "add_bookmark",
  "add_kanban_card",
  "append_to_periodic_note",
  "create_base",
  "create_canvas",
  "create_periodic_note",
  "delete_attachment",
  "find_or_create_periodic_note",
  "format_table",
  "get_attachment",
  "get_periodic_note",
  "insert_table_column",
  "insert_table_row",
  "list_attachments",
  "list_bookmarks",
  "list_kanban_boards",
  "list_periodic_notes",
  "list_workspaces",
  "move_attachment",
  "move_kanban_card",
  "open_workspace",
  "query_base",
  "query_canvas",
  "read_base",
  "read_canvas",
  "read_kanban_board",
  "remove_bookmark",
  "save_workspace",
  "sort_table_by_column",
  "update_base",
  "update_canvas",
] as const;

// bundle_files/bundle_folder deliberately absent — see the module comment.
const M4_PLUGIN_BRIDGE = [
  "create_excalidraw",
  "eval_dataview_field",
  "execute_command",
  "execute_template",
  "git_commit",
  "git_diff",
  "git_log",
  "git_stage",
  "git_status",
  "list_commands",
  "list_quickadd_actions",
  "list_tasks",
  "list_templates",
  "makemd_list_spaces",
  "makemd_query",
  "ocr_attachment",
  "ocr_bulk",
  "query_datacore",
  "read_excalidraw",
  "read_metadata_fields",
  "refresh_plugin_capabilities",
  "remotely_save_status",
  "remotely_save_trigger",
  "resolve_daily_note",
  "search_omnisearch",
  "tasks_filter",
  "trigger_quickadd",
  "update_excalidraw",
  "update_task",
  "validate_dql",
] as const;

const M1_GRAPH_ANALYSIS = [
  "graph_centrality",
  "graph_communities",
  "suggest_links",
  "find_link_cycles",
  "prune_hub_links",
] as const;

/** Every tool name `toolFacade.profile: "core"` hides and dispatch-rejects. Absent from this list
 *  (and therefore always visible/callable) under `"full"` (the default) too — `"full"` disables
 *  nothing. See the module comment for the evidence behind each family. */
export const NON_CORE_TOOL_NAMES: readonly string[] = Object.freeze([
  ...M3_STRUCTURED_DOCUMENTS,
  ...M4_PLUGIN_BRIDGE,
  ...M1_GRAPH_ANALYSIS,
]);

const NON_CORE_SET: ReadonlySet<string> = new Set(NON_CORE_TOOL_NAMES);

/** True when `name` is hidden and dispatch-rejected under `toolFacade.profile: "core"` — i.e.
 *  visible/callable only under `"full"` (the default). */
export function isNonCoreTool(name: string): boolean {
  return NON_CORE_SET.has(name);
}

/** The `toolVisibility.disabledByProfile` value for a resolved `toolFacade.profile` — every
 *  non-core name under `"core"`, none under `"full"`. The one call site (server-runtime.ts) that
 *  turns config into the registry's static visibility config uses this rather than inlining the
 *  ternary, so it stays a one-line call as more profiles (if any) are ever added. */
export function disabledByProfileFor(profile: "full" | "core"): readonly string[] {
  return profile === "core" ? NON_CORE_TOOL_NAMES : [];
}
