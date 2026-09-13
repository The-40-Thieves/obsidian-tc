// THE-1038 / GH #927: anchor resolution used to be private to write.ts (patch_note) because
// nothing else in the notes domain needed it. read_note's section read (added in a later commit
// on this branch) needs the exact same heading/block/preamble resolution patch_note already
// computes on every call, so it moved here — one place to fix the heading-scan defects (#922,
// #926) instead of two. Pure functions over strings: no filesystem, no vault types, nothing
// beyond the shared error taxonomy for the ambiguous-anchor refusal (GH #922 shape 3).
import { err } from "@the-40-thieves/obsidian-tc-shared";

export const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/** Mirrors the PatchAnchor input union (schemas.ts) without a zod dependency here. */
export type ResolvedAnchor =
  | { type: "heading"; heading: string }
  | { type: "block"; block_id: string }
  | { type: "frontmatter" };

/** THE-603: what a patch* helper produced, plus the blast radius of a `replace` — the count and
 *  byte size of lines the operation actually discarded (always 0 for append/prepend, which only
 *  insert). `bodyLineCount` is the WHOLE body's line count (not just the targeted section), so a
 *  caller can judge "removed most of the note" rather than just "removed a lot of lines". */
export interface PatchResult {
  body: string;
  removedLines: number;
  removedBytes: number;
  bodyLineCount: number;
}

export function removedSpan(
  lines: string[],
  from: number,
  to: number,
  eol: string,
): [number, number] {
  const removed = lines.slice(from, to);
  return [removed.length, removed.length > 0 ? Buffer.byteLength(removed.join(eol), "utf8") : 0];
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** GH #926: a line whose trimmed form starts with ``` or ~~~ opens a fence; it closes only on a
 *  line starting with the SAME fence character, so a ``` nested inside a ~~~ block is content,
 *  not a close. Returns, per line, whether a heading test on that line must be ignored — true for
 *  the delimiter lines themselves (never real headings) and every line strictly between them. */
function fenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fenceChar: "`" | "~" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const wasFenced = fenceChar !== null;
    const t = (lines[i] ?? "").trim();
    if (fenceChar === null) {
      if (t.startsWith("```")) fenceChar = "`";
      else if (t.startsWith("~~~")) fenceChar = "~";
    } else if (t.startsWith(fenceChar === "`" ? "```" : "~~~")) {
      fenceChar = null;
    }
    mask[i] = wasFenced || fenceChar !== null;
  }
  return mask;
}

/** GH #926 (suggested guard): true when `body` ends with an odd number of fence-delimiter lines —
 *  i.e. a fence opened but never closed. write.ts compares this before/after a patch rather than
 *  refusing outright, so a note that already had an unclosed fence is not refused on every
 *  subsequent, unrelated patch. */
export function hasUnterminatedFence(body: string): boolean {
  let fenceChar: "`" | "~" | null = null;
  let toggles = 0;
  for (const raw of body.split(/\r?\n/)) {
    const t = raw.trim();
    if (fenceChar === null) {
      if (t.startsWith("```")) {
        fenceChar = "`";
        toggles++;
      } else if (t.startsWith("~~~")) {
        fenceChar = "~";
        toggles++;
      }
    } else if (t.startsWith(fenceChar === "`" ? "```" : "~~~")) {
      fenceChar = null;
      toggles++;
    }
  }
  return toggles % 2 === 1;
}

export interface SectionSpan {
  /** 0-based inclusive line index where the section starts: the heading line, the block
   *  paragraph's first line, or 0 for the preamble. */
  startIndex: number;
  /** 0-based EXCLUSIVE line index where the section ends: the next same-or-higher heading, one
   *  past a block's `^id` line, the first heading (preamble), or the body's line count at EOF. */
  endIndex: number;
  /** Present only for a heading anchor. */
  headingLevel?: number;
}

export type SectionResolution =
  | ({ found: true } & SectionSpan)
  | { found: false; reason: "not_found" }
  | { found: false; reason: "ambiguous"; matchLines: number[] };

/** Resolve `anchor` against `body`. Pure: never throws, never touches disk. Heading matching is
 *  skipped while fenced (GH #926) in every scan below: the anchor scan, the section-end scan, the
 *  preamble's end-of-region scan, and the block anchor's paragraph-start walk. GH #922 shape 3: a
 *  heading (or block id) matching more than one line is `ambiguous`, not silently bound to the
 *  first match — `matchLines` are 1-based, relative to `body`. */
export function resolveSection(body: string, anchor: ResolvedAnchor): SectionResolution {
  const lines = body.split(/\r?\n/);
  const mask = fenceMask(lines);

  if (anchor.type === "frontmatter") {
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (mask[i]) continue;
      if (HEADING.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }
    return { found: true, startIndex: 0, endIndex: end };
  }

  if (anchor.type === "heading") {
    const want = anchor.heading.trim().toLowerCase();
    const matches: Array<{ index: number; level: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (mask[i]) continue;
      const m = HEADING.exec(lines[i] ?? "");
      if (m && (m[2] ?? "").trim().toLowerCase() === want)
        matches.push({ index: i, level: (m[1] ?? "").length });
    }
    if (matches.length === 0) return { found: false, reason: "not_found" };
    if (matches.length > 1)
      return { found: false, reason: "ambiguous", matchLines: matches.map((m) => m.index + 1) };
    const { index: hi, level } = matches[0] as { index: number; level: number };
    let end = lines.length;
    for (let j = hi + 1; j < lines.length; j++) {
      if (mask[j]) continue;
      const m = HEADING.exec(lines[j] ?? "");
      if (m && (m[1] ?? "").length <= level) {
        end = j;
        break;
      }
    }
    return { found: true, startIndex: hi, endIndex: end, headingLevel: level };
  }

  // block
  const re = new RegExp(`(?:^|\\s)\\^${escapeRegExp(anchor.block_id)}\\s*$`);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i] ?? "")) matches.push(i);
  if (matches.length === 0) return { found: false, reason: "not_found" };
  if (matches.length > 1)
    return { found: false, reason: "ambiguous", matchLines: matches.map((i) => i + 1) };
  const bi = matches[0] as number;
  let start = bi;
  while (start > 0) {
    const prev = lines[start - 1] ?? "";
    if (prev.trim() === "") break;
    if (!mask[start - 1] && HEADING.test(prev)) break;
    start--;
  }
  return { found: true, startIndex: start, endIndex: bi + 1 };
}

/** GH #928: `patch_note operation:"replace_text"` — an exact-string substitution scoped to one
 *  resolved section's text. `count` lets the caller distinguish "not found" (0) from "ambiguous"
 *  (2+); `body` is unchanged (equal to the input) unless `count === 1`. */
export interface ReplaceTextResult {
  body: string;
  count: number;
}

export function replaceInSection(
  body: string,
  span: SectionSpan,
  oldString: string,
  newString: string,
  eol: string,
): ReplaceTextResult {
  const lines = body.split(/\r?\n/);
  const sectionText = lines.slice(span.startIndex, span.endIndex).join(eol);
  const count = sectionText.split(oldString).length - 1;
  if (count !== 1) return { body, count };
  const nextSection = sectionText.replace(oldString, newString);
  const next = [
    ...lines.slice(0, span.startIndex),
    ...nextSection.split(/\r?\n/),
    ...lines.slice(span.endIndex),
  ];
  return { body: next.join(eol), count };
}

function ambiguousError(
  kind: "heading" | "block reference",
  matchLines: number[],
  extra: Record<string, unknown>,
) {
  return err.invalidInput(
    `ambiguous ${kind}: matches ${matchLines.length} lines (${matchLines.join(", ")})`,
    { ...extra, count: matchLines.length, lines: matchLines },
  );
}

function notFoundError(anchor: ResolvedAnchor, extra?: Record<string, unknown>) {
  return err.invalidInput(
    anchor.type === "block" ? "block reference not found" : "target heading not found",
    { ...extra, anchor },
  );
}

/** Resolve `anchor`, throwing the same `invalid_input` both tools surface for an anchor that
 *  cannot be resolved unambiguously — read_note (GH #927) matches patch_note's messages exactly. */
export function resolveSectionOrThrow(
  body: string,
  anchor: ResolvedAnchor,
  path?: string,
): SectionSpan {
  const r = resolveSection(body, anchor);
  if (r.found) return r;
  const extra = path ? { path } : undefined;
  if (r.reason === "not_found") throw notFoundError(anchor, extra);
  throw ambiguousError(anchor.type === "block" ? "block reference" : "heading", r.matchLines, {
    ...extra,
    anchor,
  });
}

function splice(
  lines: string[],
  op: "append" | "prepend" | "replace",
  prependAt: number,
  replaceFrom: number,
  endAt: number,
  content: string,
  eol: string,
): PatchResult {
  const ins = content.split(/\r?\n/);
  let next: string[];
  let removedLines = 0;
  let removedBytes = 0;
  if (op === "prepend") next = [...lines.slice(0, prependAt), ...ins, ...lines.slice(prependAt)];
  else if (op === "append") next = [...lines.slice(0, endAt), ...ins, ...lines.slice(endAt)];
  else {
    [removedLines, removedBytes] = removedSpan(lines, replaceFrom, endAt, eol);
    next = [...lines.slice(0, replaceFrom), ...ins, ...lines.slice(endAt)];
  }
  return { body: next.join(eol), removedLines, removedBytes, bodyLineCount: lines.length };
}

/** Insert/replace content relative to a heading section. Returns null if the heading is not
 *  found; throws GH #922 shape 3's ambiguous-anchor refusal when more than one heading matches.
 *  The section spans the heading line to the next heading of the same or higher level (or EOF),
 *  skipping fenced code (GH #926). `eol` preserves the note's line ending. */
export function patchByHeading(
  body: string,
  op: "append" | "prepend" | "replace",
  target: string,
  content: string,
  eol: string,
): PatchResult | null {
  const r = resolveSection(body, { type: "heading", heading: target });
  if (!r.found) {
    if (r.reason === "not_found") return null;
    throw ambiguousError("heading", r.matchLines, { heading: target });
  }
  const lines = body.split(/\r?\n/);
  return splice(lines, op, r.startIndex + 1, r.startIndex + 1, r.endIndex, content, eol);
}

/** THE-198: insert/replace content relative to a block reference (`^block-id`). The block spans
 *  backward from the `^id` line to the paragraph start (a blank line, a heading, or body start),
 *  skipping fenced code in the heading check (GH #926). Returns null when the block id is absent;
 *  throws GH #922 shape 3's ambiguous-anchor refusal when the id occurs on more than one line. */
export function patchByBlock(
  body: string,
  op: "append" | "prepend" | "replace",
  blockId: string,
  content: string,
  eol: string,
): PatchResult | null {
  const r = resolveSection(body, { type: "block", block_id: blockId });
  if (!r.found) {
    if (r.reason === "not_found") return null;
    throw ambiguousError("block reference", r.matchLines, { block_id: blockId });
  }
  const lines = body.split(/\r?\n/);
  return splice(lines, op, r.startIndex, r.startIndex, r.endIndex, content, eol);
}

/** GH #922 shape 2: `replace` content that repeats the section's own anchor heading duplicates
 *  it. Ruling: DROP the content's first non-blank line when it is an ATX heading whose level and
 *  trimmed text (case-insensitive) match the anchor's, rather than refusing. */
export function dropDuplicateLeadingHeading(
  content: string,
  level: number,
  heading: string,
): string {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  if (i >= lines.length) return content;
  const m = HEADING.exec(lines[i] ?? "");
  if (!m) return content;
  if ((m[1] ?? "").length !== level) return content;
  if ((m[2] ?? "").trim().toLowerCase() !== heading.trim().toLowerCase()) return content;
  return [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n");
}

/** THE-198: insert/replace content in the body preamble — the region above the
 *  first heading (the frontmatter-adjacent top of the note). Always resolvable. */
export function patchByPreamble(
  body: string,
  op: "append" | "prepend" | "replace",
  content: string,
  eol: string,
): PatchResult {
  const r = resolveSection(body, { type: "frontmatter" });
  const lines = body.split(/\r?\n/);
  const end = r.found ? r.endIndex : lines.length;
  return splice(lines, op, 0, 0, end, content, eol);
}
