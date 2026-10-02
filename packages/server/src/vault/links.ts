// Markdown link extraction + Obsidian-style resolution.
// Extracts [[wikilinks]], ![[embeds]], [md](links) and ![md](embeds) with line/
// col and a code-block flag (fenced blocks and inline `code` spans are marked so
// callers can ignore links inside code). Resolution follows Obsidian: an exact
// vault path wins; otherwise a basename match, shortest-path-wins, with all
// candidates surfaced so resolvers can raise path_ambiguous.

import { inCodeRange, inlineCodeRanges, scanMdLinks, scanWikilinks } from "./link-scan";

export type LinkKind = "wikilink" | "markdown" | "embed";

/** Where in a note a link was written: its body, or one of its properties (frontmatter). */
export type LinkSource = "body" | "property";

export interface ExtractedLink {
  raw: string;
  kind: LinkKind;
  target: string;
  display: string | null;
  heading: string | null;
  /** 1-based. A body link counts from the first body line; a property link, from the note file's
   *  first line (its frontmatter block opens at line 1). */
  line: number;
  col: number; // 1-based
  inCodeblock: boolean;
  /** Absent means "body" (what `extractLinks` returns); `extractPropertyLinks` sets "property". */
  source?: LinkSource;
  /** The top-level property a property link sits under; set only when `source` is "property". */
  property?: string;
}

const FENCE = /^\s*(```|~~~)/;

function splitWikilink(inner: string): {
  target: string;
  display: string | null;
  heading: string | null;
} {
  let rest = inner;
  let display: string | null = null;
  // In a markdown table Obsidian requires the alias pipe to be escaped ("\|");
  // treat the first "\|" or "|" as the separator so the backslash is not left on
  // the target (GH #279).
  const pipeM = rest.match(/\\?\|/);
  if (pipeM?.index !== undefined) {
    display = rest.slice(pipeM.index + pipeM[0].length).trim();
    rest = rest.slice(0, pipeM.index);
  }
  let heading: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    heading = rest.slice(hash + 1).trim() || null;
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), display, heading };
}

export function extractLinks(body: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const lines = body.split(/\r?\n/);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    const ranges = fenced ? [] : inlineCodeRanges(line);
    for (const m of scanWikilinks(line)) {
      const { target, display, heading } = splitWikilink(m.inner);
      out.push({
        raw: m.raw,
        kind: m.bang ? "embed" : "wikilink",
        target,
        display,
        heading,
        line: i + 1,
        col: m.start + 1,
        inCodeblock: fenced || inCodeRange(ranges, m.start),
      });
    }
    for (const m of scanMdLinks(line)) {
      out.push({
        raw: m.raw,
        kind: m.bang ? "embed" : "markdown",
        target: m.url.trim(),
        display: m.display.trim() || null,
        heading: null,
        line: i + 1,
        col: m.start + 1,
        inCodeblock: fenced || inCodeRange(ranges, m.start),
      });
    }
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

const MAX_PROPERTY_DEPTH = 16;

/** Every string leaf of a parsed YAML value (scalars, list items, nested map values). */
function stringLeaves(value: unknown, out: string[], depth = 0): void {
  if (typeof value === "string") out.push(value);
  else if (depth >= MAX_PROPERTY_DEPTH) return;
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out, depth + 1);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) stringLeaves(v, out, depth + 1);
}

/** Links written in a note's properties, as Obsidian caches them (`CachedMetadata.frontmatterLinks`,
 *  1.4.0+): a `[[wikilink]]` inside a property's string value, in a text property or any item of a
 *  list property. Obsidian requires the value quoted ("internal links must be surrounded by quotes",
 *  help.obsidian.md/properties), which is the YAML rule that makes it a string: an unquoted `[[X]]`
 *  parses as a nested list, holds no bracketed string, and yields nothing here. Link syntax (alias,
 *  `#heading`, `#^block`) is the body parser's `scanWikilinks`/`splitWikilink`, not a second one.
 *  Takes the PARSED frontmatter (null when absent or unparseable: no property links) and its
 *  verbatim text, used only to give each link a file line/col. */
export function extractPropertyLinks(
  frontmatter: Record<string, unknown> | null,
  rawFrontmatter: string | null,
): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  if (!frontmatter) return out;
  const lines = (rawFrontmatter ?? "").split(/\r?\n/);
  // Properties are walked in document order, so a forward-moving cursor pairs each link with its
  // own occurrence even when the same link text repeats.
  let curLine = 0;
  let curCol = 0;
  for (const [property, value] of Object.entries(frontmatter)) {
    const strings: string[] = [];
    stringLeaves(value, strings);
    for (const text of strings) {
      for (const textLine of text.split(/\r?\n/)) {
        for (const m of scanWikilinks(textLine)) {
          const { target, display, heading } = splitWikilink(m.inner);
          let line = curLine;
          let col = -1;
          for (let i = curLine; i < lines.length && col < 0; i++) {
            col = (lines[i] ?? "").indexOf(m.raw, i === curLine ? curCol : 0);
            if (col >= 0) line = i;
          }
          if (col >= 0) {
            curLine = line;
            curCol = col + m.raw.length;
          }
          out.push({
            raw: m.raw,
            kind: m.bang ? "embed" : "wikilink",
            target,
            display,
            heading,
            // +1 to count from 1, +1 for the opening "---" line ahead of the block's first line.
            line: line + 2,
            col: col >= 0 ? col + 1 : 1,
            inCodeblock: false,
            source: "property",
            property,
          });
        }
      }
    }
  }
  return out;
}

/** All links of a parsed note: its property links, then its body links. */
export function extractNoteLinks(note: {
  frontmatter: Record<string, unknown> | null;
  rawFrontmatter: string | null;
  body: string;
}): ExtractedLink[] {
  return [
    ...extractPropertyLinks(note.frontmatter, note.rawFrontmatter),
    ...extractLinks(note.body),
  ];
}

export interface VaultIndex {
  paths: string[];
  byBasename: Map<string, string[]>;
  byLowerPath: Map<string, string>;
}

export function buildVaultIndex(notePaths: string[]): VaultIndex {
  const byBasename = new Map<string, string[]>();
  const byLowerPath = new Map<string, string>();
  for (const p of notePaths) {
    const lower = p.toLowerCase();
    byLowerPath.set(lower, p);
    byLowerPath.set(lower.replace(/\.md$/, ""), p);
    const base = (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p)
      .replace(/\.md$/i, "")
      .toLowerCase();
    const arr = byBasename.get(base) ?? [];
    arr.push(p);
    byBasename.set(base, arr);
  }
  return { paths: notePaths, byBasename, byLowerPath };
}

export interface Resolution {
  resolved: boolean;
  target_path?: string;
  candidates?: string[];
}

/** Resolve a wikilink/markdown target (link part only — strip `#heading`/`|alias`
 *  before calling). Internal targets only; external URLs return unresolved. */
export function resolveTarget(index: VaultIndex, target: string): Resolution {
  const t = target.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (t === "" || /^[a-z]+:\/\//i.test(t) || t.startsWith("#")) return { resolved: false };
  const lower = t.toLowerCase();
  const withMd = lower.endsWith(".md") ? lower : `${lower}.md`;
  const exact = index.byLowerPath.get(lower) ?? index.byLowerPath.get(withMd);
  if (exact) return { resolved: true, target_path: exact };
  const base = (t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t)
    .replace(/\.md$/i, "")
    .toLowerCase();
  const matches = index.byBasename.get(base) ?? [];
  if (matches.length === 1) return { resolved: true, target_path: matches[0] };
  if (matches.length > 1) {
    const sorted = [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return { resolved: true, target_path: sorted[0], candidates: sorted };
  }
  return { resolved: false };
}
