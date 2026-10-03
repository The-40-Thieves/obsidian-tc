// The seal on a generated wiki page (see wiki-generated.ts): `generated_by: obsidian-tc` marks the
// page, `generated_hash` is the sha256 of the whole file with that one line blanked, so any later
// byte change, anywhere in the file, shows. Pure and import-free so the link scans can use it.
import { createHash } from "node:crypto";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MARKER = /^generated_by: obsidian-tc[ \t]*$/m;
const HASH_LINE = /^generated_hash: ?.*$/m;

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** `text` with its `generated_hash:` line emptied: what the hash is computed over. */
export const blankHash = (text: string): string =>
  text.replace(HASH_LINE, () => "generated_hash: ");

/** `text` (carrying a blank `generated_hash:` line) with the hash filled in. */
export const seal = (text: string): string =>
  text.replace(HASH_LINE, () => `generated_hash: ${sha(blankHash(text))}`);

export type GeneratedState = "ours" | "edited" | "foreign";

/** Whether `raw` is a page we generated and nobody changed since. */
export function inspectGenerated(raw: string): GeneratedState {
  const fm = FRONTMATTER.exec(raw)?.[1];
  if (fm === undefined || !MARKER.test(fm)) return "foreign";
  const stored = /^generated_hash: ?([0-9a-f]{64})[ \t]*$/m.exec(fm)?.[1];
  return stored !== undefined && stored === sha(blankHash(raw)) ? "ours" : "edited";
}

/** Whether a note's frontmatter says the server generated it (sealed or not). The link scans skip
 *  such a page as a link SOURCE: an index that links every page must not rescue an orphan. */
export function isGeneratedPage(raw: string): boolean {
  const fm = FRONTMATTER.exec(raw)?.[1];
  return fm !== undefined && MARKER.test(fm);
}
