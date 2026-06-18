// YAML frontmatter parse/serialize. Body bytes are preserved verbatim (the slice
// after the frontmatter block is never rewritten), so content_hash over the body
// is stable. Frontmatter key order is preserved via object insertion order;
// existing keys keep their position, new keys append. Comments inside the
// frontmatter block are not preserved (best-effort; full Document-level fidelity
// is a later enhancement) — bodies, which carry the prose, are byte-exact.
import { err } from "@obsidian-tc/shared";
import YAML from "yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export type Frontmatter = Record<string, unknown>;

export interface ParsedNote {
  frontmatter: Frontmatter | null;
  body: string;
  hasFrontmatter: boolean;
}

/** Split a note into its frontmatter object (if any) and verbatim body. */
export function parseNote(raw: string): ParsedNote {
  const m = FRONTMATTER.exec(raw);
  if (!m) return { frontmatter: null, body: raw, hasFrontmatter: false };
  let fm: Frontmatter;
  try {
    const parsed = YAML.parse(m[1] ?? "") as unknown;
    fm =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Frontmatter) : {};
  } catch {
    throw err.invalidInput("frontmatter is not valid YAML");
  }
  return { frontmatter: fm, body: raw.slice(m[0].length), hasFrontmatter: true };
}

/** Read just the frontmatter, or null when absent/empty. */
export function readFrontmatter(raw: string): Frontmatter | null {
  return parseNote(raw).frontmatter;
}

/**
 * Re-emit a note from frontmatter + body. An empty/null frontmatter yields the
 * body alone (no empty `---` block). Body is appended verbatim.
 */
export function serializeNote(frontmatter: Frontmatter | null, body: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
  const yamlText = YAML.stringify(frontmatter, { lineWidth: 0 }).replace(/\n+$/, "");
  return `---\n${yamlText}\n---\n${body}`;
}
