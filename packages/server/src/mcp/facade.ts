// Progressive-disclosure facade over the MCP tool boundary (THE-219 consolidation follow-up).
// BOUNDARY-ONLY: nothing here touches registry.dispatch, the ACL / Policy / HITL / idempotency /
// throttle pipeline, or observability — those key off requiredScopes + the destructive flag, not
// MCP tool identity, so this facade sits cleanly on top and hides nothing. In "triad" mode
// tools/list advertises three meta-tools instead of the full ~103; find_capability and
// describe_capability are pure metadata over the caller-visible catalog, and call_capability routes
// the named TARGET straight through registry.dispatch so every gate fires unchanged. Every
// registered tool stays callable by name, so a client that already knows a name is never blocked.
import type { Tool } from "@modelcontextprotocol/server";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { bm25Score, tokenize } from "../search/native";
import { TOOL_DOMAINS, type ToolDefinition, type ToolDomain } from "./registry";

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

// THE-824: what the WIRE `destructive` annotation says, as distinct from `def.destructive` (which
// also drives dispatch-time authorization via isMutatingCall/hitlRequired and must stay untouched
// by advertisement concerns). A tool that calls requireConfirmation only conditionally never sets
// the real `destructive` flag — doing so would make dispatch demand a token on every call — but
// leaving it unset made every one of these tools advertise `destructive: false`, contradicting the
// MCP spec's own default (destructiveHint defaults to true). Shared by describeCapability,
// domainTools here, and mcp/server.ts's toolAnnotations, so the three surfaces cannot drift apart.
export function isAdvertisedDestructive(
  def: Pick<ToolDefinition, "destructive" | "conditionallyDestructive">,
): boolean {
  return def.destructive === true || def.conditionallyDestructive === true;
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
 *
 * THE-823: `z.strictObject`, not `z.object` — the envelope itself is now validated at dispatch
 * (mcp/server.ts's tools/call handler) before the ad hoc `args.name` / `args.args` extraction runs.
 * Previously CALL_CAPABILITY_SCHEMA's `args: z.record(...).default({})` was the trap: a caller that
 * wrote "arguments" instead of "args" got that key silently stripped (z.object drops unknown keys),
 * `args` fell back to its `.default({})`, and the TARGET tool was dispatched with an EMPTY object —
 * so the error the caller saw named the target's missing required fields, never its own typo.
 * `z.strictObject` turns an unrecognized envelope key into one `unrecognized_keys` issue instead.
 * Compatibility note: a caller currently sending extra top-level keys on find/describe/call_capability
 * (previously dropped silently) now gets rejected — see CHANGELOG.
 */
export const FIND_CAPABILITY_SCHEMA = z.strictObject({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});
export const DESCRIBE_CAPABILITY_SCHEMA = z.strictObject({ name: z.string().min(1) });
export const CALL_CAPABILITY_SCHEMA = z.strictObject({
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
        "Search this server's full tool catalog by natural-language query and return the best-matching capabilities (name + one-line summary). Use it to discover which tool to call, then describe_capability for its schema and call_capability to run it. To enumerate the whole caller-visible catalog grouped by domain instead of searching it, read the obsidian-tc://catalog resource.",
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
    annotations: { read_only: !mutating, destructive: isAdvertisedDestructive(def) },
    ...(def.icons ? { icons: def.icons } : {}),
  };
  describeMemo.set(def, out);
  return out;
}

// ---- Domain-verb mode (shipped under THE-275; see the caveat) ---------------------------------
// THE-275 was CANCELLED. Its actual proposal — stamping per-tool visibility `tags` and shipping a
// hand-curated ~20-tool preset — was never built; only 15 of 150 definitions carry `tags` to this
// day. What landed under its number is this domain-verb mode, which superseded that proposal
// rather than implementing it. Recorded because the ticket number appears in several places in the
// tree and a reader who looks it up finds a cancelled ticket. See
// docs/adr/0006-the-default-surface-is-the-triad.md.
// In "domain" mode tools/list advertises ~a dozen domain meta-tools instead of the full surface or
// the triad. Each domain tool takes { action, args }: `action` names one capability in that domain
// and `args` is passed through. call routing is identical to call_capability (registry.dispatch, so
// every gate + the target's own Layer-6 schema validation fire) — this is a BOUNDARY-ONLY grouping,
// not a new dispatch path. Membership lives on the tool itself (`def.domain`, THE-513); a tool can
// no longer be forgotten from a separate catalog, so nothing is ever hidden.
//
// THE-577: before THE-513, membership lived in a hand-maintained DOMAINS map here, and nothing
// enforced that it tracked the registry — it fell 38 tools behind (146 registered, 108 mapped)
// silently, because domainTools() swept anything unmapped into an "other" bucket. Whole families
// (git, kanban, tables, snapshots, work-memory) collapsed into one "Miscellaneous capabilities."
// bucket that reproduced exactly the tool-selection ambiguity domain mode exists to remove. THE-513
// deleted that map: a tool declares its own domain at its definition site (a compile error if it
// doesn't), so the drift class the map enabled cannot recur. `tool-facade-domain-coverage.test.ts`
// still fails CI in both directions: a tool whose declared domain is unknown, or a domain id with
// zero members.
//
// Display metadata (title + blurb) for each domain id — the only per-domain catalog left, and it is
// exactly the 13 ids in TOOL_DOMAINS (registry.ts), not a members list.
const DOMAIN_META: Record<ToolDomain, { title: string; blurb: string }> = {
  notes: {
    title: "Notes",
    blurb: "Read, write, move, copy, and delete vault notes, and restore them from snapshots.",
  },
  metadata: {
    title: "Metadata",
    blurb: "Frontmatter, properties, and tags.",
  },
  links: {
    title: "Links",
    blurb: "Backlinks, outgoing links, orphans, link maintenance, and link-graph health.",
  },
  search: {
    title: "Search",
    blurb: "Full-text, regex, semantic, and query-language search.",
  },
  vault: {
    title: "Vault",
    blurb: "Vault registry, runtime registration, and the search index.",
  },
  attachments: {
    title: "Attachments",
    blurb: "Attachment files and OCR.",
  },
  structured: {
    title: "Structured documents",
    blurb: "Bases, canvases, Excalidraw drawings, Kanban boards, and markdown tables.",
  },
  workspace: {
    title: "Workspace",
    blurb: "Bookmarks, workspaces, and periodic notes.",
  },
  automation: {
    title: "Automation",
    blurb: "Commands, templates, Dataview, MakeMD, QuickAdd, tasks, bundles, and URIs.",
  },
  git: {
    title: "Git",
    blurb: "Vault version control via the Obsidian Git companion bridge.",
  },
  knowledge: {
    title: "Knowledge",
    blurb:
      "Knowledge graph, entities, memory, work-memory, capture queue, sessions, and provenance.",
  },
  docs: {
    title: "External docs",
    blurb: "Search and triage the vendor and external-docs corpus.",
  },
  admin: {
    title: "Admin",
    blurb: "Server config, ACL inspection, health, and metrics.",
  },
};

const DOMAIN_NAMES = new Set<string>(TOOL_DOMAINS);

/** True when `name` is a domain meta-tool (advertised only in "domain" mode). */
export function isDomainTool(name: string): boolean {
  return DOMAIN_NAMES.has(name) || name === "other";
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
    const dom = t.domain ?? "other";
    const arr = groups.get(dom);
    if (arr) arr.push(t);
    else groups.set(dom, [t]);
  }
  const order = [...TOOL_DOMAINS, "other"];
  const out: Tool[] = [];
  for (const dom of order) {
    const members = groups.get(dom);
    if (!members || members.length === 0) continue;
    members.sort((a, b) => a.name.localeCompare(b.name));
    const spec = DOMAIN_META[dom as ToolDomain];
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
        destructiveHint: members.some((m) => isAdvertisedDestructive(m)),
        openWorldHint: false,
      },
    });
  }
  return out;
}

// ---- Catalog discovery (THE-937) ---------------------------------------------------------------
// find_capability answers "which tool does X", not "what exists". Two layers close that gap over
// ONE source of truth, buildCatalog: an instructions category summary (renderInstructions, every
// session, no call) and the full catalog as a resource (obsidian-tc://catalog, resources.ts's
// readCatalogResource, read on demand). The two are formatters over buildCatalog's output so they
// cannot drift apart.

export interface CatalogGroup {
  domain: ToolDomain;
  title: string;
  tools: { name: string; summary: string }[];
}

/**
 * Groups the caller-visible catalog by domain: {domain, title, tools: [{name, summary}]}, in
 * TOOL_DOMAINS order. A domain with no caller-visible member is dropped (mirrors domainTools()'s
 * ACL filtering) — a caller never sees a domain it holds nothing in.
 */
export function buildCatalog(tools: ToolDefinition[]): CatalogGroup[] {
  const groups = new Map<ToolDomain, { name: string; summary: string }[]>();
  for (const t of tools) {
    if (!t.domain) continue; // sink-type fixtures with no domain never reach a real registry
    const entry = { name: t.name, summary: summarize(t.description) };
    const arr = groups.get(t.domain);
    if (arr) arr.push(entry);
    else groups.set(t.domain, [entry]);
  }
  const out: CatalogGroup[] = [];
  for (const dom of TOOL_DOMAINS) {
    const members = groups.get(dom);
    if (!members || members.length === 0) continue;
    members.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ domain: dom, title: DOMAIN_META[dom].title, tools: members });
  }
  return out;
}

/** Flattens buildCatalog's grouped output for the obsidian-tc://catalog resource: one row per
 *  tool, `{domain, name, summary}`, ordered by domain then name — no schemas. */
export function renderCatalogResource(
  groups: CatalogGroup[],
): { domain: ToolDomain; name: string; summary: string }[] {
  return groups.flatMap((g) => g.tools.map((t) => ({ domain: g.domain, ...t })));
}

// THE-937: a STATIC seed (live episode_stats would make instructions non-deterministic per
// install), seeded from the reporter's top nine (GH #877), filled to 3-4 per domain with the
// tools whose descriptions best summarize it. `read_notes` dropped to keep `notes` at four.
const TOP_TOOLS_BY_DOMAIN: Record<ToolDomain, readonly string[]> = {
  notes: ["list_notes", "read_note", "write_note", "patch_note"],
  metadata: ["read_frontmatter", "update_frontmatter", "add_tag", "find_notes_by_property"],
  links: ["get_backlinks", "get_outgoing_links", "find_orphans", "vault_health_score"],
  search: ["search_text", "search_regex", "search_semantic", "search_vault"],
  vault: ["add_vault", "list_vaults", "index_vault", "reload_vault"],
  attachments: ["list_attachments", "get_attachment", "ocr_attachment"],
  structured: ["read_base", "create_canvas", "read_kanban_board", "format_table"],
  workspace: ["list_bookmarks", "add_bookmark", "list_workspaces", "get_periodic_note"],
  automation: ["list_commands", "execute_command", "list_templates", "execute_template"],
  git: ["git_status", "git_diff", "git_log", "git_commit"],
  knowledge: ["create_entity", "link_entities", "add_observation", "query_entity_graph"],
  docs: ["knowledge_search", "knowledge_get_critical"],
  admin: ["server_health", "get_index_status", "inspect_acl", "get_metrics"],
};

/**
 * Renders the 13-domain category summary embedded in `instructions` (THE-937): one line per
 * domain (title + blurb) plus the allowlisted names present in `groups` — a caller never sees a
 * name it cannot call, and a domain with none still gets its blurb line. Approximates tokens as
 * chars/4; the capping test asserts on chars directly against MAX_INSTRUCTIONS_CHARS.
 */
export const MAX_INSTRUCTIONS_CHARS = 2_000;

export function renderInstructions(groups: CatalogGroup[]): string {
  const visibleByDomain = new Map<ToolDomain, Set<string>>(
    groups.map((g) => [g.domain, new Set(g.tools.map((t) => t.name))]),
  );
  const lines = TOOL_DOMAINS.map((dom) => {
    const meta = DOMAIN_META[dom];
    const visible = visibleByDomain.get(dom);
    const names = visible ? TOP_TOOLS_BY_DOMAIN[dom].filter((n) => visible.has(n)) : [];
    const suffix = names.length > 0 ? ` (e.g. ${names.join(", ")})` : "";
    return `- ${meta.title}: ${meta.blurb}${suffix}`;
  });
  return lines.join("\n");
}

// THE-718's feedback clause plus THE-937's 13-domain catalog summary. One function so the two
// instruction surfaces in mcp/server.ts (the Server constructor's static `instructions` option,
// answering legacy `initialize`; and the per-request `server/discover` override) render
// byte-identical prose for the same tool set and cannot drift apart.
export function buildInstructions(name: string, version: string, tools: ToolDefinition[]): string {
  const preamble =
    `${name} ${version} — an MCP server over Obsidian vaults. ` +
    `Tools are authorized per call (scopes + folder ACL); resources are vault notes. ` +
    `After acting on a retrieved chunk, report whether it helped via record_retrieval_feedback ` +
    `— retrieval quality is learned from that signal and nothing else supplies it.`;
  return (
    `${preamble}\n\nCapabilities by domain (read obsidian-tc://catalog for the full ` +
    `caller-visible list):\n${renderInstructions(buildCatalog(tools))}`
  );
}
