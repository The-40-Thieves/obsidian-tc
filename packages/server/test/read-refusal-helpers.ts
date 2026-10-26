// Shared assertions for the read-refusal walker tests (read-refusal-walkers*.test.ts).
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";

/** The data of a successful tool call; throws with the envelope otherwise. */
export function okData(r: ToolResult): Record<string, unknown> {
  if (!r.ok) throw new Error(`call failed: ${JSON.stringify(r)}`);
  return r.data as Record<string, unknown>;
}

/** The sorted paths of a search result's items. */
export function itemPaths(d: Record<string, unknown>): string[] {
  return (d.items as Array<{ path: string }>).map((i) => i.path).sort();
}

/** The search tools that walk every note, with input that selects the readable notes of a "zebra" vault. */
export const TEXT_SEARCH_TOOLS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["search_text", { query: "zebra" }],
  ["search_regex", { pattern: "zebra" }],
  ["search_jsonlogic", { logic: { "!!": [{ var: "path" }] } }],
  ["search_vault", { query: "zebra", mode: "text" }],
];
