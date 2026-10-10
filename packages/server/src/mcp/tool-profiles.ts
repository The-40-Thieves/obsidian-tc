import type { FacadeMode } from "./facade-mode";

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
//   tables), 32 tools — curated on a STRUCTURAL criterion, not usage: #877 gives no evidence either
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
  "write_attachment",
] as const;

// bundle_files/bundle_folder deliberately absent — see the module comment.
const M4_PLUGIN_BRIDGE = [
  "append_active_file",
  "create_excalidraw",
  "delete_active_file",
  "eval_dataview_field",
  "execute_command",
  "execute_template",
  "get_active_file",
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
  "patch_active_file",
  "query_datacore",
  "read_excalidraw",
  "read_metadata_fields",
  "refresh_plugin_capabilities",
  "remotely_save_status",
  "remotely_save_trigger",
  "resolve_daily_note",
  "search_omnisearch",
  "show_file_in_obsidian",
  "tasks_filter",
  "trigger_quickadd",
  "update_active_file",
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

// `suggest_tags` (MCP sampling consumer): optional client-side LLM help with no usage evidence yet,
// and `core` is capped at 100 tools (docgen-stats.test.ts). Curated out on the same structural
// criterion as the graph-analysis family, not on a usage claim; the tool stays discoverable.
const M1_SAMPLING_CONSUMERS = ["suggest_tags"] as const;

// `get_provenance` (per-note write history): an audit query that needs the extra read:provenance
// scope, and `core` is capped at 100 tools (docgen-stats.test.ts). Curated out on the same
// structural criterion; it stays registered and discoverable under `"core"`.
const M1_PROVENANCE = ["get_provenance"] as const;

// The wiki family (`find_existing_page`, `lint_wiki`, `draft_wiki_page`, `commit_wiki_page`): checks
// and a drafting/commit path for agents that maintain a wiki, and `core` is capped at 100 tools
// (docgen-stats.test.ts). Curated out on the same structural criterion; all stay registered and
// discoverable, and the scheduled lint is separate.
const M7_WIKI_UPKEEP = [
  "find_existing_page",
  "lint_wiki",
  "draft_wiki_page",
  "commit_wiki_page",
] as const;

/** Every tool name `toolFacade.profile: "core"` hides and dispatch-rejects. Absent from this list
 *  (and therefore always visible/callable) under `"full"` (the default) too — `"full"` disables
 *  nothing. See the module comment for the evidence behind each family. */
export const NON_CORE_TOOL_NAMES: readonly string[] = Object.freeze([
  ...M3_STRUCTURED_DOCUMENTS,
  ...M4_PLUGIN_BRIDGE,
  ...M1_GRAPH_ANALYSIS,
  ...M1_SAMPLING_CONSUMERS,
  ...M1_PROVENANCE,
  ...M7_WIKI_UPKEEP,
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

// Tool-budget profiles. `toolFacade.profile` above decides what is VISIBLE and CALLABLE at all
// (and rejects the rest at dispatch). The subsets below only decide what a FLAT tools/list
// ADVERTISES: an advertisement budget for clients that cap the tools they accept (Antigravity and
// Windsurf 100, Gemini Enterprise 100 actions, VS Code / Copilot Studio / Vertex 128 per request,
// Codex defers everything past 100). Nothing here is an authorization boundary: a tool outside the
// advertised subset stays registered, scope-checked and callable by name, exactly like
// `toolVisibility.hidden`.

/** Which subset of the caller-visible tools a flat tools/list advertises. `"all"` is no narrowing. */
export type AdvertiseSubset = "all" | "core" | "essentials";

// A curated, flat middle profile: about one real, named, schema-resolved tool per domain, no
// meta-tools and no generic executors (ChatGPT's directory rejects those, and some models do worse
// with a facade). Chosen on the same structural criterion as the core curation above: filesystem
// and index tools that work with no companion plugin. `git` has no entry on purpose (every git
// tool needs the live Obsidian Git bridge). Order is grouping only; tools/list order is the
// registry's, so it is stable by construction.
const ESSENTIALS_BY_DOMAIN = {
  notes: [
    "list_notes",
    "read_note",
    "read_notes",
    "write_note",
    "append_note",
    "patch_note",
    "move_note",
    "delete_note",
  ],
  metadata: ["read_frontmatter", "update_frontmatter", "find_notes_by_property"],
  links: ["get_backlinks", "get_outgoing_links", "find_unresolved_links"],
  search: ["search_text", "search_semantic", "search_vault", "search_and_read"],
  vault: ["list_vaults", "index_vault"],
  attachments: ["get_attachment"],
  structured: ["read_canvas"],
  workspace: ["get_periodic_note", "append_to_periodic_note"],
  automation: ["bundle_files"],
  knowledge: [
    "vault_context",
    "create_entity",
    "add_observation",
    "query_entity_graph",
    "plur_recall",
    "record_retrieval_feedback",
  ],
  docs: ["knowledge_search", "knowledge_get_critical"],
  admin: ["server_health", "get_index_status", "get_task_status"],
} as const;

/** The curated essentials profile (see above). `ESSENTIALS_RESERVED_SLOTS` is added on top when
 *  those tools are registered. */
export const ESSENTIALS_TOOL_NAMES: readonly string[] = Object.freeze(
  Object.values(ESSENTIALS_BY_DOMAIN).flat(),
);

/** `search` and `fetch`: the two generic retrieval tools clients such as ChatGPT expect by name.
 *  They are advertised in essentials the moment they are registered, with no edit to this file;
 *  while neither exists the slot is empty (test/tool-budget-profiles.test.ts holds the assertion). */
export const ESSENTIALS_RESERVED_SLOTS: readonly string[] = Object.freeze(["search", "fetch"]);

const ESSENTIALS_SET: ReadonlySet<string> = new Set([
  ...ESSENTIALS_TOOL_NAMES,
  ...ESSENTIALS_RESERVED_SLOTS,
]);

/** True when a flat tools/list under `subset` advertises `name`. */
export function isAdvertisedIn(subset: AdvertiseSubset, name: string): boolean {
  if (subset === "essentials") return ESSENTIALS_SET.has(name);
  if (subset === "core") return !NON_CORE_SET.has(name);
  return true;
}

/** What `/mcp/<segment>` selects: a facade mode and an advertised subset. */
export interface UrlSurface {
  mode: FacadeMode;
  advertise: AdvertiseSubset;
}

// `/mcp` itself is not here: it is "whatever the config says" (the triad unless an operator chose
// otherwise). "core" is the EXISTING core curation (101 tools), advertised flat; it is not the
// middle profile, which is "essentials".
const URL_SURFACES: Readonly<Record<string, UrlSurface>> = Object.freeze({
  triad: { mode: "triad", advertise: "all" },
  domain: { mode: "domain", advertise: "all" },
  full: { mode: "flat", advertise: "all" },
  core: { mode: "flat", advertise: "core" },
  essentials: { mode: "flat", advertise: "essentials" },
});

// Claude Code defers MCP tools unless `_meta` asks for upfront load; only the triad (the entry point) asks.
export const ALWAYS_LOAD_META = Object.freeze({ "anthropic/alwaysLoad": true });

/** The `/mcp/<segment>` names that resolve to a surface. The authorization layer derives the resource
 *  URLs it accepts from this list (auth/resource-set.ts), so a surface added above is signed in to
 *  without touching a second list. */
export const URL_SURFACE_NAMES: readonly string[] = Object.freeze(Object.keys(URL_SURFACES));

/** The surface for a `/mcp/<segment>` path segment, or undefined for an unknown name. Own keys
 *  only: `constructor`, `__proto__` and friends must not resolve to an inherited object. */
export function urlSurfaceFor(segment: string): UrlSurface | undefined {
  return Object.hasOwn(URL_SURFACES, segment) ? URL_SURFACES[segment] : undefined;
}
