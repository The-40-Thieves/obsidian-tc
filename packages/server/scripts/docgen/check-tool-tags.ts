// Invariant check for the tool-tag vocabulary over the LIVE registry: every registered tool carries
// tags, every tag is in the vocabulary, and every vocabulary tag is carried by at least one tool.
// Pure over its input (scripts/check-tool-tags.ts feeds it the real registry) so the failure
// shapes are unit-testable.
//
// Same discipline as scripts/check-config-threading.mjs: both directions (a tool with a tag the
// vocabulary does not know; a vocabulary tag no tool carries), a floor so an extractor that found
// nothing cannot report a clean result, and canaries with known tags that must be present for the
// scan to count as armed.
import type { ToolDefinition } from "../../src/mcp/registry";
import { TOOL_TAG_VOCABULARY, TOOL_TAGS } from "../../src/mcp/tool-tags";

/** A registry this small means extraction broke, not that the surface shrank. */
export const MIN_TOOLS = 100;

/** Tools whose tags are known facts about them; if they disagree, the scan is not looking at the
 *  real registry (or derivation is broken). */
const CANARIES: ReadonlyArray<{ tool: string; tags: readonly string[] }> = [
  { tool: "read_note", tags: ["read-only", "domain:notes"] },
  { tool: "delete_note", tags: ["writes", "destructive", "hitl", "domain:notes"] },
  { tool: "bulk_create_notes", tags: ["writes", "bulk", "hitl"] },
  { tool: "git_status", tags: ["read-only", "plugin-bridge", "domain:git"] },
  { tool: "search_semantic", tags: ["external-network"] },
];

export function checkToolTags(tools: readonly ToolDefinition[]): string[] {
  const problems: string[] = [];
  if (tools.length < MIN_TOOLS) {
    problems.push(
      `registry floor: enumerated ${tools.length} tools (< ${MIN_TOOLS}) — the extractor is broken, not the tags`,
    );
    return problems;
  }

  const used = new Set<string>();
  for (const t of tools) {
    const tags = t.tags ?? [];
    if (tags.length === 0) problems.push(`tool ${t.name} has no tags`);
    for (const tag of tags) {
      used.add(tag);
      if (!TOOL_TAGS.has(tag)) problems.push(`tool ${t.name} carries unknown tag "${tag}"`);
    }
    const access = tags.filter((x) => x === "read-only" || x === "writes");
    if (access.length !== 1)
      problems.push(`tool ${t.name} must carry exactly one of read-only/writes, has [${access}]`);
    if (!tags.some((x) => x.startsWith("domain:")))
      problems.push(`tool ${t.name} has no domain:* tag`);
  }

  for (const tag of Object.keys(TOOL_TAG_VOCABULARY)) {
    if (!used.has(tag)) problems.push(`vocabulary tag "${tag}" is carried by no tool`);
  }

  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const c of CANARIES) {
    const def = byName.get(c.tool);
    if (def === undefined) {
      problems.push(`canary ${c.tool} is not registered — the scan is not armed`);
      continue;
    }
    const missing = c.tags.filter((tag) => !(def.tags ?? []).includes(tag));
    if (missing.length > 0)
      problems.push(`canary ${c.tool} lacks expected tag(s) ${missing.join(", ")}`);
  }
  return problems;
}
