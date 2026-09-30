// Frozen ORACLE: the regex-based link/tag/prune implementations exactly as they shipped on main
// at commit cb8f1da873a0947bbae4c79f1de8fcf125d177a9 (packages/server/src/vault/{links,rewrite,
// prune,tags}.ts), copied verbatim apart from the `original` name prefix. Nothing here may be
// edited to track the production code: the whole point is an independent reference that the linear
// scanner (link-scan.ts) and the O(log n) inline-code marking are compared against. Not imported
// by production code.
import type { ExtractedLink, LinkKind, VaultIndex } from "../src/vault/links";
import { resolveTarget } from "../src/vault/links";

// ---- links.ts @ cb8f1da8 ----
const FENCE = /^\s*(```|~~~)/;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MDLINK = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const INLINE_CODE = /`[^`]*`/g;

function originalSplitWikilink(inner: string): {
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

function originalCodeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of line.matchAll(INLINE_CODE)) {
    const i = m.index ?? 0;
    ranges.push([i, i + m[0].length]);
  }
  return ranges;
}
function originalInCode(ranges: Array<[number, number]>, idx: number): boolean {
  return ranges.some(([a, b]) => idx >= a && idx < b);
}

export function originalExtractLinks(body: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const lines = body.split(/\r?\n/);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    const ranges = fenced ? [] : originalCodeRanges(line);
    for (const m of line.matchAll(WIKILINK)) {
      const idx = m.index ?? 0;
      const embed = m[1] === "!";
      const { target, display, heading } = originalSplitWikilink(m[2] ?? "");
      out.push({
        raw: m[0],
        kind: embed ? "embed" : "wikilink",
        target,
        display,
        heading,
        line: i + 1,
        col: idx + 1,
        inCodeblock: fenced || originalInCode(ranges, idx),
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
        inCodeblock: fenced || originalInCode(ranges, idx),
      });
    }
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

// ---- rewrite.ts @ cb8f1da8 (the alias separator is kept as written and nothing is trimmed) ----
function originalSplitParts(inner: string): {
  target: string;
  display: string | null;
  heading: string | null;
  // The alias separator as written: "\|" inside a table, "|" otherwise. Re-emitted
  // verbatim so a rewrite cannot unescape a table pipe and break the row (GH #279).
  pipeSep: string;
} {
  let rest = inner;
  let display: string | null = null;
  let heading: string | null = null;
  let pipeSep = "|";
  const pipeM = rest.match(/\\?\|/);
  if (pipeM?.index !== undefined) {
    pipeSep = pipeM[0];
    display = rest.slice(pipeM.index + pipeM[0].length);
    rest = rest.slice(0, pipeM.index);
  }
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    heading = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), display, heading, pipeSep };
}

/** Map a link target to its replacement, or null to leave it unchanged. */
export type OriginalTargetMapper = (target: string, kind: LinkKind) => string | null;

export function originalRewriteLinks(
  raw: string,
  map: OriginalTargetMapper,
): { text: string; count: number } {
  let count = 0;
  const crlf = raw.includes("\r\n");
  const lines = raw.split(/\r?\n/);
  let fenced = false;
  const out = lines.map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    let l = line.replace(WIKILINK, (m, bang: string, inner: string) => {
      const { target, display, heading, pipeSep } = originalSplitParts(inner);
      const next = map(target, bang === "!" ? "embed" : "wikilink");
      if (next === null) return m;
      count++;
      let v = next;
      if (heading !== null) v += `#${heading}`;
      if (display !== null) v += `${pipeSep}${display}`;
      return `${bang}[[${v}]]`;
    });
    l = l.replace(MDLINK, (m, bang: string, disp: string, url: string) => {
      const next = map(url.trim(), bang === "!" ? "embed" : "markdown");
      if (next === null) return m;
      count++;
      return `${bang}[${disp}](${next})`;
    });
    return l;
  });
  return { text: out.join(crlf ? "\r\n" : "\n"), count };
}

// ---- prune.ts @ cb8f1da8 ----
// One alternation so wikilinks and markdown links are visited left-to-right in a
// single pass: g1/g2 = wikilink bang/inner, g3/g4/g5 = markdown bang/display/url.
const LINK = /(!?)\[\[([^\]\n]+?)\]\]|(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const BULLET_ONLY = /^[\s>*+-]*$/;

export type PruneReason = "unresolved" | "duplicate";
export interface PruneResult {
  text: string;
  removed: Array<{ target: string; line: number; reason: PruneReason }>;
}

export interface PrunePolicy {
  removeUnresolved: boolean;
  removeDuplicates: boolean;
}

export function originalPruneHubLinks(
  raw: string,
  index: VaultIndex,
  policy: PrunePolicy,
): PruneResult {
  const crlf = raw.includes("\r\n");
  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();
  const removed: PruneResult["removed"] = [];
  let fenced = false;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }

    let removals = 0;
    const next = line.replace(
      LINK,
      (full, wBang: string, wInner: string, mBang: string, mDisp: string, mUrl: string) => {
        const isWiki = wInner !== undefined;
        let target: string;
        let display: string | null;
        let kind: "wikilink" | "embed" | "markdown";
        if (isWiki) {
          // "\|" is the alias separator inside a table; split on it, not on the
          // raw pipe, so the backslash is not left on the target (GH #279).
          const pipeM = wInner.match(/\\?\|/);
          display =
            pipeM?.index !== undefined ? wInner.slice(pipeM.index + pipeM[0].length).trim() : null;
          const beforePipe = pipeM?.index !== undefined ? wInner.slice(0, pipeM.index) : wInner;
          const hash = beforePipe.indexOf("#");
          target = (hash >= 0 ? beforePipe.slice(0, hash) : beforePipe).trim();
          kind = wBang === "!" ? "embed" : "wikilink";
        } else {
          target = (mUrl ?? "").trim();
          display = (mDisp ?? "").trim() || null;
          kind = mBang === "!" ? "embed" : "markdown";
        }

        const isExternalUrl = kind === "markdown" && /^[a-z]+:\/\//i.test(target);
        if (isExternalUrl) return full;

        const res = resolveTarget(index, target);
        if (!res.resolved) {
          if (policy.removeUnresolved) {
            removed.push({ target, line: i + 1, reason: "unresolved" });
            removals++;
            return display ?? "";
          }
          return full;
        }
        const path = res.target_path ?? target;
        if (seen.has(path)) {
          if (policy.removeDuplicates) {
            removed.push({ target, line: i + 1, reason: "duplicate" });
            removals++;
            return display ?? "";
          }
          return full;
        }
        seen.add(path);
        return full;
      },
    );

    if (removals === 0) out.push(line);
    else if (!BULLET_ONLY.test(next)) out.push(next);
    // else: the line collapsed to a bare bullet/blank — drop it
  }

  return { text: out.join(crlf ? "\r\n" : "\n"), removed };
}

// ---- tags.ts @ cb8f1da8 ----
const TAGS_INLINE_CODE = /`[^`]*`/g;
// A tag is `#` (at start-of-line or after whitespace) then a run of tag chars
// beginning with a non-slash. Group 1 is the boundary char, group 2 the tag.
const TAG = /(^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;

/** Normalize a user/string tag: strip a leading `#`, trim, drop trailing slashes. */
export function originalNormalizeTag(tag: string): string {
  return tag.replace(/^#/, "").trim().replace(/\/+$/, "");
}

/** Inline `#hashtags` in body order, de-duplicated, code-aware. */
export function originalExtractInlineTags(body: string): string[] {
  const out = new Set<string>();
  const lines = body.split(/\r?\n/);
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const ranges = [...line.matchAll(TAGS_INLINE_CODE)].map(
      (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as [number, number],
    );
    for (const m of line.matchAll(TAG)) {
      const hashIdx = (m.index ?? 0) + (m[1] ?? "").length;
      if (ranges.some(([a, b]) => hashIdx >= a && hashIdx < b)) continue;
      const tag = originalNormalizeTag(m[2] ?? "");
      if (tag && /[A-Za-z_-]/.test(tag)) out.add(tag);
    }
  }
  return [...out];
}

/** The regex prune.ts used, exposed so scanLinks can be compared match-for-match. */
export const ORIGINAL_PRUNE_LINK = LINK;
