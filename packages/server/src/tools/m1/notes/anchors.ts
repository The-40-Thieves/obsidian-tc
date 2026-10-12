// THE-1038 / GH #927: anchor resolution used to be private to write.ts (patch_note) because
// nothing else in the notes domain needed it. read_note's section read needs the exact same
// heading/block/preamble resolution patch_note already computes on every call, so it lives here —
// one place to fix the heading-scan defects (#922, #926) instead of two. Pure functions over
// strings: no filesystem, no vault types, nothing beyond the shared error taxonomy for the
// ambiguous-anchor refusal (GH #922 shape 3).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import {
  headingMatches,
  matchHeadingBoundary,
  scanHeadings,
  stripAsciiIndent,
} from "./heading-syntax";

/** Mirrors the PatchAnchor input union (schemas.ts) without a zod dependency here. */
export type ResolvedAnchor =
  | { type: "heading"; heading: string; occurrence?: number | undefined }
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
  /** Present when append used insert_before. The caller turns non-unique matches into a refusal
   *  and decides whether line-level diagnostics may be disclosed. */
  insertBefore?: {
    count: number;
    matchLines: number[];
    section: SectionSpan;
    searchable: SectionSpan;
  };
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

/** Length of the leading run of `ch` in `s` (0 if `s` doesn't start with `ch`). */
function leadingRun(s: string, ch: string): number {
  let n = 0;
  while (s[n] === ch) n++;
  return n;
}

/** Strip ONLY trailing ASCII space/tab off `line` — the counterpart of `stripAsciiIndent` for the
 *  other end of a fence delimiter line (pre-merge U1). `trimEnd()` strips every Unicode
 *  whitespace, which let a closer with a trailing NBSP (or ideographic space) close a fence that
 *  CommonMark leaves open: only spaces and tabs may follow the delimiter run. */
function trimAsciiEnd(line: string): string {
  let end = line.length;
  while (end > 0) {
    const ch = line[end - 1];
    if (ch === " " || ch === "\t") end--;
    else break;
  }
  return line.slice(0, end);
}

function realLineCount(body: string, lines: string[]): number {
  const hasTrailingPhantom =
    lines.length > 0 && lines[lines.length - 1] === "" && /\r?\n$/.test(body);
  return hasTrailingPhantom ? lines.length - 1 : lines.length;
}

function insertBeforeLineMatches(
  lines: string[],
  mask: boolean[],
  index: number,
  needle: string,
): boolean {
  return !mask[index] && trimAsciiEnd(lines[index] ?? "") === needle;
}

/** CommonMark-ish fenced-code state machine, shared by `fenceMask` and `hasUnterminatedFence`
 *  (GH #926; review round 1 I2/M8, round 2 Codex's shorter-closer-with-trailing-text repro, round
 *  3 G1/G2, round 4 R2's ASCII-only indentation). A line opens a fence when, after stripping AT
 *  MOST 3 columns of ASCII space/tab indentation (tabs expand to the next 4-column stop — round 3
 *  G1; 4+ columns is an indented code block, not a fence — round 1 M8; any OTHER leading
 *  whitespace-looking character, e.g. NBSP, is content, not indentation — round 4 R2), its
 *  form — with only trailing ASCII space/tab stripped, since a trailing NBSP makes the line content
 *  rather than a delimiter (pre-merge U1) — is a run of 3+ backticks or 3+ tildes, with two
 *  exceptions:
 *  a backtick run's info string (the text after the run) may not itself contain a backtick —
 *  CommonMark disallows this because it would collide with inline code spans — while a tilde
 *  run's info string has no such restriction (round 3 G2). Once open, a line closes it only when
 *  its trimmed form is NOTHING BUT a run of the SAME character, at least as long as the opener's
 *  run — shorter (a 3-backtick line inside a 4-backtick fence), a different character (a ``` inside
 *  a ~~~ block), or trailing text after the run (` ``` extra`) are all content, not a close. */
function createFenceTracker() {
  let char: "`" | "~" | null = null;
  let openLen = 0;
  return {
    get fenced(): boolean {
      return char !== null;
    },
    /** Feed one raw (untrimmed) line; returns true iff this line is itself a fence delimiter
     *  (open or close) — never real content, never a heading. */
    feed(line: string): boolean {
      const { col, rest } = stripAsciiIndent(line);
      if (col > 3) return false;
      const t = trimAsciiEnd(rest);
      if (char === null) {
        const backticks = leadingRun(t, "`");
        if (backticks >= 3 && !t.slice(backticks).includes("`")) {
          char = "`";
          openLen = backticks;
          return true;
        }
        const tildes = leadingRun(t, "~");
        if (tildes >= 3) {
          char = "~";
          openLen = tildes;
          return true;
        }
        return false;
      }
      const runLen = leadingRun(t, char);
      if (runLen >= openLen && runLen === t.length) {
        char = null;
        openLen = 0;
        return true;
      }
      return false;
    },
  };
}

/** GH #926: track fence state across `lines`. Returns, per line, whether a heading test on that
 *  line must be ignored — true for the delimiter lines themselves (never real headings) and every
 *  line strictly between them. */
function fenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  const tracker = createFenceTracker();
  for (let i = 0; i < lines.length; i++) {
    const wasFenced = tracker.fenced;
    const isDelim = tracker.feed(lines[i] ?? "");
    mask[i] = wasFenced || isDelim;
  }
  return mask;
}

/** GH #926 (suggested guard): true when `body` ends with an odd number of fence-delimiter lines —
 *  i.e. a fence opened but never closed. write.ts compares this before/after a patch rather than
 *  refusing outright, so a note that already had an unclosed fence is not refused on every
 *  subsequent, unrelated patch. */
export function hasUnterminatedFence(body: string): boolean {
  const tracker = createFenceTracker();
  let toggles = 0;
  for (const line of body.split(/\r?\n/)) if (tracker.feed(line)) toggles++;
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
  /** Present only for a heading anchor: the RESOLVED heading's own text (the last segment of a
   *  `Parent > Child` path), which is what a caller's repeated heading line is compared against. */
  headingTitle?: string;
}

export type SectionResolution =
  | ({ found: true } & SectionSpan)
  | { found: false; reason: "not_found" }
  | { found: false; reason: "ambiguous"; matchLines: number[] }
  // A heading anchor's `occurrence` exceeds the match count; `matchLines` are the 1-based lines of
  // the matches that DO exist.
  | { found: false; reason: "out_of_range"; matchLines: number[]; occurrence: number };

/** Resolve `anchor` against `body`. Pure: never throws, never touches disk. Heading matching is
 *  skipped while fenced (GH #926) in every scan below: the anchor scan, the section-end scan, the
 *  preamble's end-of-region scan, and the block anchor's paragraph-start walk. GH #922 shape 3: a
 *  heading (or block id) matching more than one line is `ambiguous`, not silently bound to the
 *  first match — `matchLines` are 1-based, relative to `body`. Every heading recognition below
 *  uses `matchHeadingBoundary` (up to 3 columns of ASCII indentation tolerated, empty title
 *  allowed — review round 4 R3). */
export function resolveSection(body: string, anchor: ResolvedAnchor): SectionResolution {
  const lines = body.split(/\r?\n/);
  const mask = fenceMask(lines);
  const documentEnd = realLineCount(body, lines);

  if (anchor.type === "frontmatter") {
    let end = documentEnd;
    for (let i = 0; i < documentEnd; i++) {
      if (mask[i]) continue;
      if (matchHeadingBoundary(lines[i] ?? "")) {
        end = i;
        break;
      }
    }
    return { found: true, startIndex: 0, endIndex: end };
  }

  if (anchor.type === "heading") {
    const matches = headingMatches(scanHeadings(lines, mask), anchor.heading);
    if (matches.length === 0) return { found: false, reason: "not_found" };
    const matchLines = matches.map((h) => h.index + 1);
    // More than one match and no `occurrence` is ambiguous, never silently the first.
    if (anchor.occurrence === undefined && matches.length > 1)
      return { found: false, reason: "ambiguous", matchLines };
    const occurrence = anchor.occurrence ?? 1;
    const picked = matches[occurrence - 1];
    if (!picked) return { found: false, reason: "out_of_range", matchLines, occurrence };
    const { index: hi, level, title } = picked;
    let end = documentEnd;
    for (let j = hi + 1; j < documentEnd; j++) {
      if (mask[j]) continue;
      const m = matchHeadingBoundary(lines[j] ?? "");
      if (m && m.level <= level) {
        end = j;
        break;
      }
    }
    return {
      found: true,
      startIndex: hi,
      endIndex: end,
      headingLevel: level,
      headingTitle: title,
    };
  }

  // block — GH #926 review round 2 (N2) / M5: a `^id` marker that only exists as sample text
  // inside a fenced code block is never a candidate, for resolution OR ambiguity counting.
  const re = new RegExp(`(?:^|\\s)\\^${escapeRegExp(anchor.block_id)}\\s*$`);
  const matches: number[] = [];
  for (let i = 0; i < documentEnd; i++) {
    if (mask[i]) continue;
    if (re.test(lines[i] ?? "")) matches.push(i);
  }
  if (matches.length === 0) return { found: false, reason: "not_found" };
  if (matches.length > 1)
    return { found: false, reason: "ambiguous", matchLines: matches.map((i) => i + 1) };
  const bi = matches[0] as number;
  let start = bi;
  while (start > 0) {
    const prev = lines[start - 1] ?? "";
    if (prev.trim() === "") break;
    // Review round 3 B1: a fence boundary (delimiter or fenced content) terminates the paragraph
    // exactly like a blank line or a heading does — the walk must never step onto a masked line,
    // or a `replace`/`prepend` on a block just past a fenced example deletes the fence too.
    if (mask[start - 1]) break;
    if (matchHeadingBoundary(prev)) break;
    start--;
  }
  return { found: true, startIndex: start, endIndex: bi + 1 };
}

/** Count of `needle` in `haystack`, advancing the search by ONE character per match (not
 *  `needle.length`) so overlapping occurrences are counted — review round 1 M7: `"aa"` in `"aaa"`
 *  is 2 matches (positions 0 and 1), not 1. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + 1;
  }
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
  // Review round 2 B2: the exact literal suffix (a block anchor's trailing `^id` marker, taken
  // verbatim off the end of the section text) to exclude from matching and reattach unmodified —
  // I4's heading-line protection has no block-anchor analogue since the marker is a SUFFIX of a
  // line, not the whole line. "" (default) protects nothing.
  excludeTrailing = "",
): ReplaceTextResult {
  const lines = body.split(/\r?\n/);
  const reachesTerminatedEnd =
    span.endIndex === realLineCount(body, lines) &&
    lines[lines.length - 1] === "" &&
    /\r?\n$/.test(body);
  const trailingTerminator = reachesTerminatedEnd && span.startIndex < span.endIndex ? eol : "";
  const sectionText = lines.slice(span.startIndex, span.endIndex).join(eol) + trailingTerminator;
  const protectedTrailing = excludeTrailing ? excludeTrailing + trailingTerminator : "";
  const searchableText = protectedTrailing
    ? sectionText.slice(0, sectionText.length - protectedTrailing.length)
    : sectionText;
  // Review round 1 I3: a caller's old_string/new_string are plain strings, and a multi-line one is
  // very likely authored with "\n" regardless of the note's own EOL — normalize both sides (and
  // the section text being searched) to "\n" for matching, then reassemble with `eol` so a CRLF
  // note stays CRLF end to end.
  const normalizedSection = searchableText.replace(/\r\n/g, "\n");
  const normalizedOld = oldString.replace(/\r\n/g, "\n");
  const count = countOccurrences(normalizedSection, normalizedOld);
  if (count !== 1) return { body, count };
  const normalizedNew = newString.replace(/\r\n/g, "\n");
  // Review round 2 N1: `String.replace(str, replacement)` treats a STRING replacement as a
  // template ($&, $$, $1, ...) — a replacement callback inserts `normalizedNew` literally.
  const nextNormalizedSection = normalizedSection.replace(normalizedOld, () => normalizedNew);
  const nextSection = nextNormalizedSection.split("\n").join(eol) + protectedTrailing;
  const next = [
    ...lines.slice(0, span.startIndex),
    ...nextSection.split(/\r?\n/),
    ...lines.slice(span.endIndex + (reachesTerminatedEnd ? 1 : 0)),
  ];
  return { body: next.join(eol), count };
}

/** What a 0-match `replace_text` refusal says about where the string is (GH #1226). Note text
 *  never appears here: headings are the only titles, everything else is a number. */
export interface ReplaceMissDetail {
  section_resolved: { heading: string | null; start_line: number; end_line: number };
  /** Anchored scope only: exact matches in the body outside the section, and the enclosing heading
   *  of each (deduped; a match before any heading adds no title). */
  found_elsewhere?: { count: number; headings: string[] };
  /** The best window of the section's searchable lines after whitespace collapse and lowercasing.
   *  Similarity 1 means the normalized old_string occurs there; otherwise it is below 1. Omitted
   *  when the section has no searchable line. */
  nearest?: { line: number; similarity: number };
}

const normalizeForMiss = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Dice coefficient over character bigrams of two normalized strings. Linear in their length, so
 *  scoring every window of a section stays cheap where an edit distance per window would not. */
function bigramDice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < a.length; i++) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i + 1 < b.length; i++) {
    const gram = b.slice(i, i + 2);
    const left = counts.get(gram) ?? 0;
    if (left > 0) {
      shared++;
      counts.set(gram, left - 1);
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** Diagnostics for a `replace_text` that matched nothing. `section` is the resolved section;
 *  `searchable` is the part a match may land in (the section less a heading anchor's own heading
 *  line); `anchored` is false for the whole-note scope, which has no outside to search. Pure. */
export function replaceMissDetail(
  body: string,
  section: SectionSpan,
  searchable: SectionSpan,
  oldString: string,
  anchored: boolean,
): ReplaceMissDetail {
  const lines = body.split(/\r?\n/);
  const detail: ReplaceMissDetail = {
    section_resolved: {
      heading: section.headingTitle ?? null,
      start_line: section.startIndex + 1,
      end_line: section.endIndex,
    },
  };
  const needle = oldString.replace(/\r\n/g, "\n");
  if (anchored && needle.length > 0) {
    const mask = fenceMask(lines);
    const headings = scanHeadings(lines, mask);
    // Line start offsets of the EOL-normalized body, so each match maps to its 0-based line.
    const text = body.replace(/\r\n/g, "\n");
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const titles = new Set<string>();
    let count = 0;
    let line = 0;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? 0) <= at) line++;
      if (line >= section.startIndex && line < section.endIndex) continue;
      count++;
      let enclosing: string | undefined;
      for (const h of headings) {
        if (h.index > line) break;
        enclosing = h.title;
      }
      if (enclosing !== undefined) titles.add(enclosing);
    }
    detail.found_elsewhere = { count, headings: [...titles] };
  }
  const window = lines.slice(searchable.startIndex, searchable.endIndex);
  const normNeedle = normalizeForMiss(oldString);
  if (window.length > 0 && normNeedle.length > 0) {
    const span = Math.min(oldString.split(/\r?\n/).length, window.length);
    let best: { line: number; similarity: number } | undefined;
    for (let i = 0; i + span <= window.length; i++) {
      const norm = normalizeForMiss(window.slice(i, i + span).join("\n"));
      // Exact only on the normalized text: a rounded score is capped below 1 so 1 always means
      // the normalized old_string occurs.
      const similarity = norm.includes(normNeedle)
        ? 1
        : Math.min(0.99, Math.round(bigramDice(norm, normNeedle) * 100) / 100);
      if (best === undefined || similarity > best.similarity)
        best = { line: searchable.startIndex + i + 1, similarity };
      if (similarity === 1) break;
    }
    if (best !== undefined) detail.nearest = best;
  }
  return detail;
}

export interface InsertBeforeMissDetail {
  section_resolved: { heading: string | null; start_line: number; end_line: number };
  /** Exact eligible-line matches outside the resolved section. */
  found_elsewhere?: { count: number; lines: number[] };
  /** Closest eligible body line in the section; the line's text is never returned. */
  nearest?: { line: number; similarity: number };
}

/** Read-authorized diagnostics for an insert_before line that was absent from its section. */
export function insertBeforeMissDetail(
  body: string,
  section: SectionSpan,
  searchable: SectionSpan,
  insertBefore: string,
): InsertBeforeMissDetail {
  const lines = body.split(/\r?\n/);
  const mask = fenceMask(lines);
  const documentEnd = realLineCount(body, lines);
  const needle = trimAsciiEnd(insertBefore);
  const detail: InsertBeforeMissDetail = {
    section_resolved: {
      heading: section.headingTitle ?? null,
      start_line: section.startIndex + 1,
      end_line: section.endIndex,
    },
  };
  const eligible = new Array<boolean>(documentEnd).fill(false);
  const headingLevels: number[] = [];
  for (let i = 0; i < documentEnd; i++) {
    if (mask[i]) continue;
    const heading = matchHeadingBoundary(lines[i] ?? "");
    if (!heading) {
      eligible[i] = true;
      continue;
    }
    while (
      headingLevels.length > 0 &&
      (headingLevels[headingLevels.length - 1] as number) >= heading.level
    )
      headingLevels.pop();
    eligible[i] = headingLevels.length > 0;
    headingLevels.push(heading.level);
  }
  const elsewhere: number[] = [];
  for (let i = 0; i < documentEnd; i++) {
    if (i >= section.startIndex && i < section.endIndex) continue;
    if (!eligible[i]) continue;
    if (insertBeforeLineMatches(lines, mask, i, needle)) elsewhere.push(i + 1);
  }
  if (elsewhere.length > 0) detail.found_elsewhere = { count: elsewhere.length, lines: elsewhere };

  const normNeedle = normalizeForMiss(needle);
  let nearest: { line: number; similarity: number } | undefined;
  if (normNeedle.length > 0) {
    for (let i = searchable.startIndex; i < searchable.endIndex; i++) {
      if (mask[i]) continue;
      const norm = normalizeForMiss(trimAsciiEnd(lines[i] ?? ""));
      const similarity =
        norm === normNeedle
          ? 1
          : Math.min(0.99, Math.round(bigramDice(norm, normNeedle) * 100) / 100);
      if (nearest === undefined || similarity > nearest.similarity)
        nearest = { line: i + 1, similarity };
    }
  }
  if (nearest !== undefined) detail.nearest = nearest;
  return detail;
}

function ambiguousError(
  kind: "heading" | "block reference",
  matchLines: number[],
  extra: Record<string, unknown>,
) {
  const hint =
    kind === "heading"
      ? '; add occurrence (1-based, in document order) to the anchor, e.g. {type:"heading",heading:"Notes",occurrence:2}, or name the parent: heading:"Parent > Notes"'
      : "";
  return err.invalidInput(
    `ambiguous ${kind}: matches ${matchLines.length} lines (${matchLines.join(", ")})${hint}`,
    { ...extra, count: matchLines.length, lines: matchLines },
  );
}

function occurrenceOutOfRangeError(
  matchLines: number[],
  occurrence: number,
  extra: Record<string, unknown>,
) {
  return err.invalidInput(
    `heading occurrence ${occurrence} is out of range: the heading matches ${matchLines.length} line${matchLines.length === 1 ? "" : "s"} (${matchLines.join(", ")})`,
    { ...extra, count: matchLines.length, lines: matchLines, occurrence },
  );
}

function notFoundError(anchor: ResolvedAnchor, extra?: Record<string, unknown>) {
  return err.invalidInput(
    anchor.type === "block" ? "block reference not found" : "target heading not found",
    { ...extra, anchor },
  );
}

/** Throw the refusal for an unresolved `SectionResolution` (heading or block; never frontmatter). */
function throwUnresolved(
  r: Exclude<SectionResolution, { found: true }>,
  anchor: ResolvedAnchor,
  extra: Record<string, unknown> | undefined,
  ambiguousExtra: Record<string, unknown>,
): never {
  if (r.reason === "not_found") throw notFoundError(anchor, extra);
  if (r.reason === "out_of_range")
    throw occurrenceOutOfRangeError(r.matchLines, r.occurrence, { ...extra, anchor });
  throw ambiguousError(anchor.type === "block" ? "block reference" : "heading", r.matchLines, {
    ...ambiguousExtra,
    anchor,
  });
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
  return throwUnresolved(r, anchor, extra, { ...extra });
}

function splice(
  lines: string[],
  op: "append" | "prepend" | "replace",
  prependAt: number,
  replaceFrom: number,
  endAt: number,
  content: string,
  eol: string,
  section: SectionSpan,
  searchable: SectionSpan,
  insertBefore?: string,
): PatchResult {
  const ins = content.split(/\r?\n/);
  let next: string[];
  let removedLines = 0;
  let removedBytes = 0;
  if (op === "prepend") next = [...lines.slice(0, prependAt), ...ins, ...lines.slice(prependAt)];
  else if (op === "append") {
    if (insertBefore === undefined)
      next = [...lines.slice(0, endAt), ...ins, ...lines.slice(endAt)];
    else {
      const mask = fenceMask(lines);
      const needle = trimAsciiEnd(insertBefore);
      const matches: number[] = [];
      for (let i = searchable.startIndex; i < searchable.endIndex; i++) {
        if (insertBeforeLineMatches(lines, mask, i, needle)) matches.push(i);
      }
      if (matches.length !== 1)
        return {
          body: lines.join(eol),
          removedLines,
          removedBytes,
          bodyLineCount: lines.length,
          insertBefore: {
            count: matches.length,
            matchLines: matches.map((i) => i + 1),
            section,
            searchable,
          },
        };
      const at = matches[0] as number;
      next = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      return {
        body: next.join(eol),
        removedLines,
        removedBytes,
        bodyLineCount: lines.length,
        insertBefore: {
          count: 1,
          matchLines: [at + 1],
          section,
          searchable,
        },
      };
    }
  } else {
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
  occurrence?: number,
  insertBefore?: string,
): PatchResult | null {
  const anchor = { type: "heading" as const, heading: target, occurrence };
  const r = resolveSection(body, anchor);
  if (!r.found) {
    if (r.reason === "not_found") return null;
    return throwUnresolved(r, anchor, undefined, { heading: target });
  }
  const lines = body.split(/\r?\n/);
  const searchable = { ...r, startIndex: r.startIndex + 1 };
  return splice(
    lines,
    op,
    r.startIndex + 1,
    r.startIndex + 1,
    r.endIndex,
    content,
    eol,
    r,
    searchable,
    insertBefore,
  );
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
  insertBefore?: string,
): PatchResult | null {
  const r = resolveSection(body, { type: "block", block_id: blockId });
  if (!r.found) {
    if (r.reason === "not_found") return null;
    throw ambiguousError("block reference", r.matchLines, { block_id: blockId });
  }
  const lines = body.split(/\r?\n/);
  return splice(
    lines,
    op,
    r.startIndex,
    r.startIndex,
    r.endIndex,
    content,
    eol,
    r,
    r,
    insertBefore,
  );
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
  // Review round 5 D1: recognized with `matchHeadingBoundary`, the same matcher every body scan
  // uses, so the comparison is indentation-insensitive on both sides — an indented anchor heading
  // is a resolvable target (round 4 R3), so its duplicate in `content` must be detectable whether
  // the caller echoed the indentation or not.
  const m = matchHeadingBoundary(lines[i] ?? "");
  if (!m) return content;
  if (m.level !== level) return content;
  if (m.title.toLowerCase() !== heading.trim().toLowerCase()) return content;
  return [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n");
}

/** THE-198: insert/replace content in the body preamble — the region above the
 *  first heading (the frontmatter-adjacent top of the note). Always resolvable. */
export function patchByPreamble(
  body: string,
  op: "append" | "prepend" | "replace",
  content: string,
  eol: string,
  insertBefore?: string,
): PatchResult {
  const r = resolveSection(body, { type: "frontmatter" });
  const lines = body.split(/\r?\n/);
  const end = r.found ? r.endIndex : lines.length;
  const span = r.found ? r : { startIndex: 0, endIndex: end };
  return splice(lines, op, 0, 0, end, content, eol, span, span, insertBefore);
}
