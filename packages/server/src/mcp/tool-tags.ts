import { isMutatingScope, parseScope } from "@the-40-thieves/obsidian-tc-shared";
import { isHitlGated } from "./registry/hitl-declaration";
import { TOOL_DOMAINS, type ToolDefinition, VERDICT_TOOL_TAG } from "./registry/types";

// The tool-tag vocabulary: the ONLY strings a tool may carry in `tags`, and so the only ones
// `toolVisibility.hiddenTags` / `disabledTags` can usefully name. Two sources, kept apart on purpose:
//
//   derived  - computed at registration from metadata the tool already declares (scopes, the
//              destructive flags, HITL gating, facade domain). A derived tag can never drift from
//              the thing it summarises, so declaring one by hand is a registration error.
//   declared - a fact no other field carries (a tool reaches the network; a retained topic label).
//              Hand-written on the definition, and only these.
//
// `plugin-bridge` is both: derived from a scope that names a companion plugin, declared for the few
// bridge tools whose scope is a generic vault scope. Declaring it where it is already derived is an
// error too, so the hand-written list stays the minimal remainder.

export type TagSource = "derived" | "declared" | "both";

export interface ToolTagSpec {
  source: TagSource;
  /** One sentence; rendered on the docs site and in error messages. */
  description: string;
}

const DOMAIN_PREFIX = "domain:";

const DOMAIN_TAGS: Record<string, ToolTagSpec> = Object.fromEntries(
  TOOL_DOMAINS.map((d) => [
    `${DOMAIN_PREFIX}${d}`,
    { source: "derived", description: `Belongs to the \`${d}\` facade domain.` },
  ]),
);

export const TOOL_TAG_VOCABULARY: Readonly<Record<string, ToolTagSpec>> = {
  "read-only": {
    source: "derived",
    description:
      "Does not mutate the vault: no write/delete/bulk/execute scope and not destructive. The same predicate as the read-only gate and the MCP `readOnlyHint`.",
  },
  writes: {
    source: "derived",
    description:
      "Mutates the vault: a write/delete/bulk/execute scope, or destructive. The complement of `read-only`.",
  },
  destructive: {
    source: "derived",
    description:
      "Can destroy data: always destructive, or destructive on some calls (the MCP `destructiveHint`).",
  },
  hitl: {
    source: "derived",
    description:
      "Requires human confirmation (an elicit token), always or on a boundary-crossing call.",
  },
  bulk: {
    source: "derived",
    description: "Holds a `bulk:*` scope: one call changes many notes.",
  },
  admin: {
    source: "derived",
    description:
      "Holds an `admin:*` scope: administers the server, its vaults, ACLs, config or metrics. Such a tool may change server state without modifying vault notes, so it can also be `read-only`.",
  },
  "plugin-bridge": {
    source: "both",
    description:
      "Needs the Obsidian companion plugin bridge (a live Obsidian session): derived from a scope naming a companion plugin, declared for bridge tools with a generic vault scope.",
  },
  "external-network": {
    source: "declared",
    description:
      "May send query or note text to a service outside the server process: a hosted embedding provider, or a cloud sync plugin.",
  },
  "client-sampling": {
    source: "declared",
    description:
      "Asks the calling client's own model to run a completion (MCP sampling), sending note text to that client. The client may prompt its user or spend its own tokens.",
  },
  experiential: {
    source: "declared",
    description: "Reads or writes the derived work-memory plane.",
  },
  [VERDICT_TOOL_TAG]: {
    source: "declared",
    description:
      "A verdict verb: its calls are recorded as verdicts, never as evidence for later retrieval.",
  },
  knowledge: { source: "declared", description: "Part of the knowledge-retrieval surface." },
  search: { source: "declared", description: "Retrieves notes or chunks by query." },
  docs: { source: "declared", description: "Reads the external vendor-docs corpus." },
  links: { source: "declared", description: "Reads the link graph." },
  graph: { source: "declared", description: "Computes graph analytics over the link graph." },
  provenance: { source: "declared", description: "Reports where an answer came from." },
  diagnostics: { source: "declared", description: "Explains or audits retrieval behaviour." },
  ...DOMAIN_TAGS,
};

export const TOOL_TAGS: ReadonlySet<string> = new Set(Object.keys(TOOL_TAG_VOCABULARY));

/** Scope resources that name an Obsidian companion plugin. A tool holding `<family>:<one of these>`
 *  proxies to that plugin through the bridge. */
const BRIDGE_SCOPE_RESOURCES: ReadonlySet<string> = new Set([
  "command",
  "daily-notes",
  "datacore",
  "dataview",
  "excalidraw",
  "git",
  "makemd",
  "metadata-menu",
  "ocr",
  "omnisearch",
  "quickadd",
  "remotely-save",
  "templater",
]);

/** A tool that mutates the vault, by the same predicate the read-only gate and the MCP
 *  `readOnlyHint` use. */
export function isMutatingDefinition(
  def: Pick<ToolDefinition, "destructive" | "requiredScopes">,
): boolean {
  return def.destructive === true || def.requiredScopes.some(isMutatingScope);
}

// What the WIRE `destructive` annotation says, as distinct from `def.destructive` (which also
// drives dispatch-time authorization and must stay untouched by advertisement concerns). A tool
// that calls requireConfirmation only conditionally never sets the real flag, since doing so would
// demand a token on every call, but it must not advertise `destructive: false` either: the MCP
// spec's own default for `destructiveHint` is true. Shared by describeCapability, the domain-mode
// tools, the tools/list annotations and the `destructive` tag so the four cannot drift apart.
export function isAdvertisedDestructive(
  def: Pick<ToolDefinition, "destructive" | "conditionallyDestructive">,
): boolean {
  return def.destructive === true || def.conditionallyDestructive === true;
}

type TaggableDefinition = Pick<
  ToolDefinition,
  | "name"
  | "domain"
  | "requiredScopes"
  | "destructive"
  | "conditionallyDestructive"
  | "inputSchema"
  | "tags"
>;

/** The tags computed from the definition's own metadata. Never includes a declared tag. */
export function deriveToolTags(def: TaggableDefinition): string[] {
  const tags: string[] = [isMutatingDefinition(def) ? "writes" : "read-only"];
  if (isAdvertisedDestructive(def)) tags.push("destructive");
  if (isHitlGated(def as ToolDefinition)) tags.push("hitl");
  const scopes = def.requiredScopes.map(parseScope);
  if (scopes.some((s) => s.family === "bulk")) tags.push("bulk");
  if (scopes.some((s) => s.family === "admin")) tags.push("admin");
  if (scopes.some((s) => BRIDGE_SCOPE_RESOURCES.has(s.resource))) tags.push("plugin-bridge");
  if (def.domain !== undefined) tags.push(`${DOMAIN_PREFIX}${def.domain}`);
  return tags;
}

/** Derived tags followed by the hand-declared remainder, or throws if a declaration is not allowed:
 *  an unknown tag, a derived-only tag written by hand, or a declaration the derivation already
 *  makes. Registration calls this, so a typo'd or drift-prone declaration never reaches the
 *  registry. The result is never empty: derivation always supplies `read-only` or `writes`, so a
 *  tool cannot register untagged. */
export function effectiveToolTags(def: TaggableDefinition): string[] {
  const derived = deriveToolTags(def);
  const declared = [...new Set(def.tags ?? [])];
  for (const tag of declared) {
    const spec = TOOL_TAG_VOCABULARY[tag];
    if (spec === undefined) {
      throw new Error(
        `tool ${def.name} declares unknown tag "${tag}"; add it to TOOL_TAG_VOCABULARY in mcp/tool-tags.ts (known: ${[...TOOL_TAGS].join(", ")})`,
      );
    }
    if (spec.source === "derived") {
      throw new Error(`tool ${def.name} declares tag "${tag}", which is computed; remove it`);
    }
    if (derived.includes(tag)) {
      throw new Error(
        `tool ${def.name} declares tag "${tag}", which is already derived; remove it`,
      );
    }
  }
  return [...derived, ...declared];
}
