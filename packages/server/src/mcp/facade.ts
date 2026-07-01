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

const JSON_SCHEMA_OPTS = { target: "draft-7", reused: "inline", unrepresentable: "any" } as const;
const toJson = (schema: z.ZodType): Tool["inputSchema"] =>
  z.toJSONSchema(schema, JSON_SCHEMA_OPTS) as unknown as Tool["inputSchema"];

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
export function triadTools(): Tool[] {
  return [
    {
      name: "find_capability",
      title: "Find capability",
      description:
        "Search this server's full tool catalog by natural-language query and return the best-matching capabilities (name + one-line summary). Use it to discover which tool to call, then describe_capability for its schema and call_capability to run it.",
      inputSchema: toJson(
        z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).default(10),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "describe_capability",
      title: "Describe capability",
      description:
        "Return the full input schema, required scopes, and safety hints (read-only / destructive) for a single capability by name.",
      inputSchema: toJson(z.object({ name: z.string().min(1) })),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "call_capability",
      title: "Call capability",
      description:
        "Invoke a capability by name with its arguments. Routes into the same authorization, ACL, HITL, idempotency, and rate-limit pipeline as a direct tool call, so every safety gate applies and the target's own schema validates the arguments.",
      inputSchema: toJson(
        z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }),
      ),
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
export function findCapability(
  tools: ToolDefinition[],
  query: string,
  limit: number,
): { name: string; summary: string; score: number }[] {
  const docs: Doc[] = tools.map((t) => ({
    name: t.name,
    tokens: tokenize(`${t.name} ${t.description}`),
    nameTokens: new Set(tokenize(t.name)),
    summary: summarize(t.description),
  }));
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
    input_schema: z.toJSONSchema(def.inputSchema, JSON_SCHEMA_OPTS),
    required_scopes: def.requiredScopes,
    annotations: { read_only: !mutating, destructive: def.destructive === true },
  };
}
