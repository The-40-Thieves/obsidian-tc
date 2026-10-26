// Shared assertions and fixtures for the read-refusal walker tests (read-refusal-walkers*.test.ts).
import { linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { makeTempDir, rmTemp } from "./tmp";

/** A file outside the vault, hard-linked into `root` at `rel`: the safe open refuses that read. The
 *  caller's `rel` directory must already exist. Returns the cleanup for the outside directory. */
export function hardLinkOutside(root: string, text: string, rel = join("n", "hl.md")): () => void {
  const outside = makeTempDir("obtc-walk-refusal-out-");
  const src = join(outside, "src.md");
  writeFileSync(src, text);
  linkSync(src, join(root, rel));
  return () => rmTemp(outside);
}

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
