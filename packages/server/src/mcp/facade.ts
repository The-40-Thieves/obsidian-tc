// Progressive-disclosure facade over the MCP tool boundary (THE-219 consolidation follow-up).
// BOUNDARY-ONLY: nothing here touches registry.dispatch, the ACL / Policy / HITL / idempotency /
// throttle pipeline, or observability — those key off requiredScopes + the destructive flag, not
// MCP tool identity, so this facade sits cleanly on top and hides nothing. In "triad" mode
// tools/list advertises three meta-tools instead of the full ~103; find_capability and
// describe_capability are pure metadata over the caller-visible catalog, and call_capability routes
// the named TARGET straight through registry.dispatch so every gate fires unchanged. Every
// registered tool stays callable by name, so a client that already knows a name is never blocked.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { bm25Score, tokenize } from "../search/native";
import type { ToolDefinition } from "./registry";

export type FacadeMode = "triad" | "domain" | "flat";

const FACADE_TOOL_NAMES = ["find_capability", "describe_capability", "call_capability"] as const;
export function isFacadeTool(name: string): boolean {
  return (FACADE_TOOL_NAMES as readonly string[]).includes(name);
}

// Emit JSON Schema 2020-12 — the default dialect of MCP 2025-11-25 (THE-278). draft-7 stays valid
// per spec, but 2020-12 aligns the advertised tool/capability schemas with the negotiated version.
export const JSON_SCHEMA_OPTS = {
  target: "draft-2020-12",
  reused: "inline",
  unrepresentable: "any",
} as const;
// THE-294: z.toJSONSchema is a pure function of a static schema, but tools/list, describe_capability,
// and the triad meta-tools recompute it per request. Memoize by schema identity — every schema here
// is a stable module const or a registered tool's inputSchema — so each is converted at most once.
const jsonSchemaMemo = new WeakMap<z.ZodType, Tool["inputSchema"]>();
export function toJson(schema: z.ZodType): Tool["inputSchema"] {
  let cached = jsonSchemaMemo.get(schema);
  if (cached === undefined) {
    cached = z.toJSONSchema(schema, JSON_SCHEMA_OPTS) as unknown as Tool["inputSchema"];
    jsonSchemaMemo.set(schema, cached);
  }
  return cached;
}

/** Human-facing label for a snake_case tool name. */
function titleize(name: string): string {
  return name
    .split("_")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The three meta-tools advertised in triad mode. Their advertised inputSchemas are deliberately
 * SHALLOW (a query string; a name; a name + passthrough args object). Strict per-tool validation
 * still happens inside registry.dispatch (Layer 6) when call_capability routes to the target, so
 * the per-domain schemas are never hand-merged back into the advertised surface.
 */
const FIND_CAPABILITY_SCHEMA = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});
const DESCRIBE_CAPABILITY_SCHEMA = z.object({ name: z.string().min(1) });
const CALL_CAPABILITY_SCHEMA = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

// THE-463: the triad catalog is immutable after module load (three meta-tools, module-constant
// schemas, memoized toJson) and is the DEFAULT facade, so tools/list rebuilt it on every request.
// Build it once. Frozen so a caller cannot mutate the shared instance.
let triadCache: Tool[] | null = null;

export function triadTools(): Tool[] {
  if (triadCache === null) triadCache = Object.freeze(buildTriadTools()) as unknown as Tool[];
  return triadCache;
}

function buildTriadTools(): Tool[] {
  return [
    {
      name: "find_capability",
      title: "Find capability",
      description:
        "Search this server's full tool catalog by natural-language query and return the best-matching capabilities (name + one-line summary). Use it to discover which tool to call, then describe_capability for its schema and call_capability to run it.",
      inputSchema: toJson(FIND_CAPABILITY_SCHEMA),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "describe_capability",
      title: "Describe capability",
      description:
        "Return the full input schema, required scopes, and safety hints (read-only / destructive) for a single capability by name.",
      inputSchema: toJson(DESCRIBE_CAPABILITY_SCHEMA),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "call_capability",
      title: "Call capability",
      description:
        "Invoke a capability by name with its arguments. Routes into the same authorization, ACL, HITL, idempotency, and rate-limit pipeline as a direct tool call, so every safety gate applies and the target's own schema validates the arguments.",
      inputSchema: toJson(CALL_CAPABILITY_SCHEMA),
      // Advisory only; the real read-only/destructive verdict is the TARGET tool's, enforced in dispatch.
      annotations: { openWorldHint: false },
    },
  ];
}

/** One-line summary from a tool description (first sentence / line, capped). */
function summarize(desc: string): string {
  const line = desc.split("\n")[0] ?? desc;
  const sentence = line.split(/(?<=\.)\s/)[0] ?? line;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

interface Doc {
  name: string;
  tokens: string[];
  nameTokens: Set<string>;
  summary: string;
}

// A tool whose NAME contains a query term is almost always the intended one (read_note for
// "read a note"), which raw BM25 over name+description under-ranks. Add a flat bonus per name hit.
const NAME_BONUS = 5;

/**
 * BM25 search over the caller-visible tool catalog (name + description). Reuses the in-process
 * tokenizer + bm25Score from the search substrate; no new index is built — the corpus is the
 * ~100 tool descriptions, tokenized per call (cheap, and only on explicit discovery).
 */
// THE-294: the per-tool tokenization (name + description) is static, but findCapability rebuilt it
// for the whole catalog on every query. Memoize each tool's Doc by definition identity; only the
// query-dependent scoring below runs per call.
const docMemo = new WeakMap<ToolDefinition, Doc>();
function toolDoc(t: ToolDefinition): Doc {
  let d = docMemo.get(t);
  if (d === undefined) {
    d = {
      name: t.name,
      tokens: tokenize(`${t.name} ${t.description}`),
      nameTokens: new Set(tokenize(t.name)),
      summary: summarize(t.description),
    };
    docMemo.set(t, d);
  }
  return d;
}

export function findCapability(
  tools: ToolDefinition[],
  query: string,
  limit: number,
): { name: string; summary: string; score: number }[] {
  const docs: Doc[] = tools.map(toolDoc);
  const docCount = docs.length || 1;
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / docCount;
  const qTerms = [...new Set(tokenize(query))];
  const docFreq = new Map<string, number>();
  for (const term of qTerms) docFreq.set(term, docs.filter((d) => d.tokens.includes(term)).length);
  const scored = docs.map((d) => {
    let score = 0;
    for (const term of qTerms) {
      const tf = d.tokens.reduce((c, tk) => (tk === term ? c + 1 : c), 0);
      score += bm25Score(tf, d.tokens.length, avgLen, docFreq.get(term) ?? 0, docCount);
      if (d.nameTokens.has(term)) score += NAME_BONUS;
    }
    return { name: d.name, summary: d.summary, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

// THE-463: a capability's description is immutable after registration, so memoize it by def identity
// (WeakMap → collectable when the def is). describe_capability rebuilt this per call.
const describeMemo = new WeakMap<ToolDefinition, Record<string, unknown>>();

/** Full metadata for a single capability: schema + required scopes + derived safety hints. */
export function describeCapability(def: ToolDefinition): Record<string, unknown> {
  const cached = describeMemo.get(def);
  if (cached !== undefined) return cached;
  const mutating = def.destructive === true || def.requiredScopes.some(isMutatingScope);
  const out: Record<string, unknown> = {
    name: def.name,
    title: titleize(def.name),
    description: def.description,
    input_schema: toJson(def.inputSchema),
    ...(def.outputSchema ? { output_schema: toJson(def.outputSchema) } : {}),
    required_scopes: def.requiredScopes,
    annotations: { read_only: !mutating, destructive: def.destructive === true },
    ...(def.icons ? { icons: def.icons } : {}),
  };
  describeMemo.set(def, out);
  return out;
}

// ---- Domain-verb mode (THE-275) --------------------------------------------------------------
// In "domain" mode tools/list advertises ~a dozen domain meta-tools instead of the full surface or
// the triad. Each domain tool takes { action, args }: `action` names one capability in that domain
// and `args` is passed through. call routing is identical to call_capability (registry.dispatch, so
// every gate + the target's own Layer-6 schema validation fire) — this is a BOUNDARY-ONLY grouping,
// not a new dispatch path. The domain map is the one catalog that must track the tool surface; a
// tool with no mapping still ships under an "other" domain, so nothing is ever hidden.
//
// THE-577: that fallback is a safety net, not a licence to drift. It kept the surface complete but
// SILENT while the map fell 38 tools behind (146 registered, 108 mapped) — whole families, git and
// kanban and tables and snapshots among them, collapsed into one "Miscellaneous capabilities."
// bucket that reproduced exactly the tool-selection ambiguity domain mode exists to remove. The map
// is now complete and `tool-facade-domain-coverage.test.ts` fails CI in BOTH directions: a tool
// registered without a domain, or a domain naming a tool that no longer exists.
interface DomainSpec {
  domain: string;
  title: string;
  blurb: string;
  members: readonly string[];
}

const DOMAINS: readonly DomainSpec[] = [
  {
    domain: "notes",
    title: "Notes",
    blurb: "Read, write, move, copy, and delete vault notes, and restore them from snapshots.",
    members: [
      "read_note",
      "read_notes",
      "write_note",
      "append_note",
      "patch_note",
      "copy_note",
      "move_note",
      "delete_note",
      "note_exists",
      "list_notes",
      "bulk_create_notes",
      "bulk_move_notes",
      // Point-in-time snapshots are note versioning: same subject, same read/write:notes scopes.
      "snapshot_note",
      "read_snapshot",
      "list_snapshots",
      "restore_note",
    ],
  },
  {
    domain: "metadata",
    title: "Metadata",
    blurb: "Frontmatter, properties, and tags.",
    members: [
      "read_frontmatter",
      "update_frontmatter",
      "read_property",
      "find_notes_by_property",
      "list_properties",
      "add_tag",
      "remove_tag",
      "get_note_tags",
      "find_notes_by_tag",
      "list_tags",
      "bulk_set_property",
      // Metadata Menu's typed fields are metadata by another route.
      "read_metadata_fields",
    ],
  },
  {
    domain: "links",
    title: "Links",
    blurb: "Backlinks, outgoing links, orphans, link maintenance, and link-graph health.",
    members: [
      "get_backlinks",
      "get_outgoing_links",
      "find_unresolved_links",
      "find_orphans",
      "rewrite_link",
      "prune_hub_links",
      // Analytics OVER the link graph rather than edits to it — vault_health_score is explicitly a
      // composite link-health score, so it belongs with the graph it scores.
      "find_link_cycles",
      "get_link_strength",
      "suggest_links",
      "vault_health_score",
    ],
  },
  {
    domain: "search",
    title: "Search",
    blurb: "Full-text, regex, semantic, and query-language search.",
    members: [
      "search_text",
      "search_regex",
      "search_semantic",
      "search_vault",
      "search_dql",
      "search_jsonlogic",
      // Plugin-backed search surfaces: Omnisearch is ranked full-text, Datacore is a query
      // language — siblings of search_dql rather than of the automation bridges.
      "search_omnisearch",
      "query_datacore",
    ],
  },
  {
    domain: "vault",
    title: "Vault",
    blurb: "Vault registry, runtime registration, and the search index.",
    members: [
      "get_vault",
      "list_vaults",
      "reload_vault",
      "reset_vault_cache",
      "index_vault",
      // Both admin:vault, both mutate what the registry knows about a vault.
      "add_vault",
      "refresh_plugin_capabilities",
    ],
  },
  {
    domain: "attachments",
    title: "Attachments",
    blurb: "Attachment files and OCR.",
    members: [
      "get_attachment",
      "list_attachments",
      "move_attachment",
      "delete_attachment",
      "ocr_attachment",
      "ocr_bulk",
    ],
  },
  {
    domain: "structured",
    title: "Structured documents",
    blurb: "Bases, canvases, Excalidraw drawings, Kanban boards, and markdown tables.",
    members: [
      "create_base",
      "read_base",
      "update_base",
      "query_base",
      "create_canvas",
      "read_canvas",
      "update_canvas",
      "query_canvas",
      "create_excalidraw",
      "read_excalidraw",
      "update_excalidraw",
      // Kanban boards and GFM tables are structure held INSIDE a note, read and edited as
      // structure rather than as prose — the same contract as bases and canvases.
      "read_kanban_board",
      "list_kanban_boards",
      "add_kanban_card",
      "move_kanban_card",
      "format_table",
      "insert_table_row",
      "insert_table_column",
      "sort_table_by_column",
    ],
  },
  {
    domain: "workspace",
    title: "Workspace",
    blurb: "Bookmarks, workspaces, and periodic notes.",
    members: [
      "add_bookmark",
      "remove_bookmark",
      "list_bookmarks",
      "list_workspaces",
      "open_workspace",
      "save_workspace",
      "create_periodic_note",
      "get_periodic_note",
      "list_periodic_notes",
      "append_to_periodic_note",
      "find_or_create_periodic_note",
      // Daily Notes resolution is the periodic-note family's other entry point.
      "resolve_daily_note",
    ],
  },
  {
    domain: "automation",
    title: "Automation",
    blurb: "Commands, templates, Dataview, MakeMD, QuickAdd, tasks, bundles, and URIs.",
    members: [
      "list_commands",
      "execute_command",
      "generate_uri",
      "list_templates",
      "execute_template",
      "eval_dataview_field",
      "validate_dql",
      "makemd_list_spaces",
      "makemd_query",
      "list_quickadd_actions",
      "trigger_quickadd",
      "bundle_files",
      "bundle_folder",
      "list_tasks",
      "tasks_filter",
      "update_task",
      // Remotely Save is a companion-plugin bridge whose verb is "kick off a run" — execution,
      // like trigger_quickadd, not vault registry state.
      "remotely_save_status",
      "remotely_save_trigger",
    ],
  },
  {
    // THE-577: the only genuinely new domain the 38-tool backfill needed. Version control is not
    // notes, metadata or automation — it is its own subject with its own scope family
    // (read:git / write:git / execute:git, the last a HITL gate), and it is what a caller looks
    // for by name. Folding it into `automation` would have pushed that domain to 21 members and
    // buried five verbs no one would think to look for there.
    domain: "git",
    title: "Git",
    blurb: "Vault version control via the Obsidian Git companion bridge.",
    members: ["git_status", "git_diff", "git_log", "git_stage", "git_commit"],
  },
  {
    domain: "knowledge",
    title: "Knowledge",
    blurb:
      "Knowledge graph, entities, memory, work-memory, capture queue, sessions, and provenance.",
    members: [
      "knowledge_challenge",
      "vault_graph_search",
      "vault_context",
      "query_entity_graph",
      "create_entity",
      "get_entity",
      "link_entities",
      "add_observation",
      "plur_get",
      "plur_recall",
      "plur_recall_hybrid",
      "plur_similarity_search",
      "enqueue_capture",
      "commit_capture",
      "list_capture_queue",
      "start_session",
      "end_session",
      "get_session_traces",
      // The experiential work-memory plane (agent_episodes) and its feedback stamp. Grouped with
      // the plur_* memory verbs already here rather than split into a second memory domain —
      // whether `knowledge` should be broken up is a curation call for THE-508, not this gate.
      "work_search",
      "work_episodes",
      "work_forget",
      "record_retrieval_feedback",
      // Recall/synthesis and session triage verbs.
      "reflect",
      "session_bootstrap",
      // Knowledge-quality surfaces: unsourced claims, unresolved contradictions, and the
      // THE-537 note-health rollup (duplicate / orphan / stale / contradicted / tombstoned).
      "audit_provenance",
      "list_contradictions",
      "note_quality_report",
    ],
  },
  {
    domain: "docs",
    title: "External docs",
    blurb: "Search and triage the vendor and external-docs corpus.",
    members: ["knowledge_search", "knowledge_get_critical"],
  },
  {
    domain: "admin",
    title: "Admin",
    blurb: "Server config, ACL inspection, health, and metrics.",
    // get_index_status sits here rather than under `vault` because it is registered directly in
    // cli.ts alongside server_health (THE-491) and reports the same class of health signal.
    members: [
      "get_metrics",
      "get_server_config",
      "inspect_acl",
      "server_health",
      "get_index_status",
    ],
  },
];

const DOMAIN_OF = new Map<string, string>();
for (const d of DOMAINS) for (const m of d.members) DOMAIN_OF.set(m, d.domain);
const DOMAIN_NAMES = new Set<string>(DOMAINS.map((d) => d.domain));
const SPEC_BY_DOMAIN = new Map<string, DomainSpec>(DOMAINS.map((d) => [d.domain, d]));

/** True when `name` is a domain meta-tool (advertised only in "domain" mode). */
export function isDomainTool(name: string): boolean {
  return DOMAIN_NAMES.has(name) || name === "other";
}

/** The domain a capability belongs to, or undefined if unmapped (would ship under "other"). */
export function domainOfTool(name: string): string | undefined {
  return DOMAIN_OF.get(name);
}

/** Every capability name the domain map claims, with its domain. Exported for THE-577's coverage
 *  gate, which must check the map in BOTH directions — `domainOfTool` only answers the forward
 *  question, so a member naming a renamed or deleted tool would otherwise go unnoticed. */
export function domainMapEntries(): ReadonlyArray<readonly [name: string, domain: string]> {
  return [...DOMAIN_OF.entries()];
}

function isReadOnly(def: ToolDefinition): boolean {
  return !(def.destructive === true || def.requiredScopes.some(isMutatingScope));
}

/**
 * Group the caller-visible catalog into domain meta-tools. Each advertised tool takes a SHALLOW
 * { action: <enum of the domain's capabilities>, args: <passthrough> }; per-action validation still
 * happens in registry.dispatch when call routes the action. Domains with no visible member are
 * dropped, so the surface reflects the caller's scopes/ACL (mirrors flat-mode filtering).
 */
export function domainTools(tools: ToolDefinition[]): Tool[] {
  const groups = new Map<string, ToolDefinition[]>();
  for (const t of tools) {
    const dom = DOMAIN_OF.get(t.name) ?? "other";
    const arr = groups.get(dom);
    if (arr) arr.push(t);
    else groups.set(dom, [t]);
  }
  const order = [...DOMAINS.map((d) => d.domain), "other"];
  const out: Tool[] = [];
  for (const dom of order) {
    const members = groups.get(dom);
    if (!members || members.length === 0) continue;
    members.sort((a, b) => a.name.localeCompare(b.name));
    const spec = SPEC_BY_DOMAIN.get(dom);
    const actions = members.map((m) => m.name);
    const lines = members.map((m) => `- ${m.name}: ${summarize(m.description)}`).join("\n");
    out.push({
      name: dom,
      title: spec?.title ?? titleize(dom),
      description: `${spec?.blurb ?? "Miscellaneous capabilities."} Call with "action" naming one capability and "args" its arguments.\nActions:\n${lines}`,
      inputSchema: toJson(
        z.object({
          action: z.enum(actions as [string, ...string[]]),
          args: z.record(z.string(), z.unknown()).default({}),
        }),
      ),
      annotations: {
        readOnlyHint: members.every(isReadOnly),
        destructiveHint: members.some((m) => m.destructive === true),
        openWorldHint: false,
      },
    });
  }
  return out;
}
