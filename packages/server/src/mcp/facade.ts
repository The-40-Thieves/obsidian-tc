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

export function triadTools(): Tool[] {
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

/** Full metadata for a single capability: schema + required scopes + derived safety hints. */
export function describeCapability(def: ToolDefinition): Record<string, unknown> {
  const mutating = def.destructive === true || def.requiredScopes.some(isMutatingScope);
  return {
    name: def.name,
    title: titleize(def.name),
    description: def.description,
    input_schema: toJson(def.inputSchema),
    ...(def.outputSchema ? { output_schema: toJson(def.outputSchema) } : {}),
    required_scopes: def.requiredScopes,
    annotations: { read_only: !mutating, destructive: def.destructive === true },
    ...(def.icons ? { icons: def.icons } : {}),
  };
}

// ---- Domain-verb mode (THE-275) --------------------------------------------------------------
// In "domain" mode tools/list advertises ~a dozen domain meta-tools instead of the full surface or
// the triad. Each domain tool takes { action, args }: `action` names one capability in that domain
// and `args` is passed through. call routing is identical to call_capability (registry.dispatch, so
// every gate + the target's own Layer-6 schema validation fire) — this is a BOUNDARY-ONLY grouping,
// not a new dispatch path. The domain map is the one catalog that must track the tool surface; a
// tool with no mapping still ships under an "other" domain, so nothing is ever hidden.
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
    blurb: "Read, write, move, copy, and delete vault notes.",
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
    ],
  },
  {
    domain: "links",
    title: "Links",
    blurb: "Backlinks, outgoing links, orphans, and link maintenance.",
    members: [
      "get_backlinks",
      "get_outgoing_links",
      "find_unresolved_links",
      "find_orphans",
      "rewrite_link",
      "prune_hub_links",
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
    ],
  },
  {
    domain: "vault",
    title: "Vault",
    blurb: "Vault registry and the search index.",
    members: ["get_vault", "list_vaults", "reload_vault", "reset_vault_cache", "index_vault"],
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
    blurb: "Bases, canvases, and Excalidraw drawings.",
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
    ],
  },
  {
    domain: "knowledge",
    title: "Knowledge",
    blurb: "Knowledge graph, entities, memory, capture queue, and sessions.",
    members: [
      "knowledge_challenge",
      "vault_graph_search",
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
    ],
  },
  {
    domain: "admin",
    title: "Admin",
    blurb: "Server config, ACL inspection, health, and metrics.",
    members: ["get_metrics", "get_server_config", "inspect_acl", "server_health"],
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
