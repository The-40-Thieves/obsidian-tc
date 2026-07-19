// Markdown link extraction + Obsidian-style resolution.
// Extracts [[wikilinks]], ![[embeds]], [md](links) and ![md](embeds) with line/
// col and a code-block flag (fenced blocks and inline `code` spans are marked so
// callers can ignore links inside code). Resolution follows Obsidian: an exact
// vault path wins; otherwise a basename match, shortest-path-wins, with all
// candidates surfaced so resolvers can raise path_ambiguous.

export type LinkKind = "wikilink" | "markdown" | "embed";

export interface ExtractedLink {
  raw: string;
  kind: LinkKind;
  target: string;
  display: string | null;
  heading: string | null;
  line: number; // 1-based
  col: number; // 1-based
  inCodeblock: boolean;
}

const FENCE = /^\s*(```|~~~)/;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MDLINK = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const INLINE_CODE = /`[^`]*`/g;

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

function codeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of line.matchAll(INLINE_CODE)) {
    const i = m.index ?? 0;
    ranges.push([i, i + m[0].length]);
  }
  return ranges;
}
function inCode(ranges: Array<[number, number]>, idx: number): boolean {
  return ranges.some(([a, b]) => idx >= a && idx < b);
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
    const ranges = fenced ? [] : codeRanges(line);
    for (const m of line.matchAll(WIKILINK)) {
      const idx = m.index ?? 0;
      const embed = m[1] === "!";
      const { target, display, heading } = splitWikilink(m[2] ?? "");
      out.push({
        raw: m[0],
        kind: embed ? "embed" : "wikilink",
        target,
        display,
        heading,
        line: i + 1,
        col: idx + 1,
        inCodeblock: fenced || inCode(ranges, idx),
      });
    }
    for (const m of line.matchAll(MDLINK)) {
      const idx = m.index ?? 0;
      const embed = m[1] === "!";
      out.push({
        raw: m[0],
        kind: embed ? "embed" : "markdown",
        target: (m[3] ?? "").trim(),
        display: (m[2] ?? "").trim() || null,
        heading: null,
        line: i + 1,
        col: idx + 1,
        inCodeblock: fenced || inCode(ranges, idx),
      });
    }
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
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
