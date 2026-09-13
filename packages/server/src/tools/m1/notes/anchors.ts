// THE-1038 / GH #927: anchor resolution used to be private to write.ts (patch_note) because
// nothing else in the notes domain needed it. read_note's section read needs the exact same
// heading/block/preamble resolution patch_note already computes on every call, so it lives here —
// one place to fix the heading-scan defects (#922, #926) instead of two. Pure functions over
// strings: no filesystem, no vault types, nothing beyond the shared error taxonomy for the
// ambiguous-anchor refusal (GH #922 shape 3).
import { err } from "@the-40-thieves/obsidian-tc-shared";

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

/** Length of the leading run of `ch` in `s` (0 if `s` doesn't start with `ch`). */
function leadingRun(s: string, ch: string): number {
  let n = 0;
  while (s[n] === ch) n++;
  return n;
}

/** Strip ONLY ASCII space/tab indentation off the start of `line`, expanding a tab to the next
 *  4-column stop (CommonMark's rule, shared by fence AND heading indentation — review round 3
 *  G1/R3). `col` is the total indentation width in columns; `rest` is the line from the first
 *  non-space/tab character onward. Any OTHER leading whitespace-LOOKING character (NBSP U+00A0,
 *  ideographic space U+3000, ...) does NOT count as indentation — `rest` starts there instead, so
 *  the line is content, not a fence delimiter or heading, however it looks after a Unicode-aware
 *  `.trim()` — review round 4 R2. */
function stripAsciiIndent(line: string): { col: number; rest: string } {
  let i = 0;
  let col = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " ") {
      col += 1;
      i++;
    } else if (ch === "\t") {
      col = Math.floor(col / 4) * 4 + 4;
      i++;
    } else break;
  }
  return { col, rest: line.slice(i) };
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

/** Recognizes an ATX heading LINE as a section BOUNDARY — review round 4 R3: tolerates up to 3
 *  columns of leading ASCII space/tab indentation (4+ is an indented code block, not a heading —
 *  the same CommonMark rule fences use, review round 3 M8), an optional closing hash sequence
 *  (`"## A ##"` has the title `"A"` — pre-merge U3), and an EMPTY title (`"##"` alone, or
 *  `"## "` with nothing after) — a real, if untargetable, boundary (no caller can anchor to
 *  `heading: ""` — the schema requires `min(1)`). Review round 5 D1: this is the ONE heading
 *  recognizer in this module — `dropDuplicateLeadingHeading` tests caller-supplied content with it
 *  too. A second, stricter column-0 regex used to live here for that narrower job, which meant an
 *  indented anchor heading was a valid TARGET whose indented duplicate in `content` went
 *  undetected, reviving the GH #922 shape 2 duplication the drop exists to prevent. */
function matchHeadingBoundary(line: string): { level: number; title: string } | null {
  const { col, rest } = stripAsciiIndent(line);
  if (col > 3) return null;
  // Pre-merge U2: the separator after the hashes is ASCII space/tab or end of line — `\s` also
  // accepted NBSP and friends, which turned a non-heading into a section boundary.
  const m = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(rest);
  if (!m) return null;
  // Pre-merge U3: an ATX closing sequence (`## A ##`) is syntax, not title text — it must be
  // preceded by a space or tab, so a trailing hash run written flush against the text (`## A#`)
  // stays part of the title. Stripped here, in the ONE shared matcher, so every consumer agrees:
  // boundary scan, anchor target, ambiguity count, and the duplicate-heading drop.
  const title = (m[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "");
  return { level: (m[1] ?? "").length, title: title.trim() };
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
}

export type SectionResolution =
  | ({ found: true } & SectionSpan)
  | { found: false; reason: "not_found" }
  | { found: false; reason: "ambiguous"; matchLines: number[] };

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

  if (anchor.type === "frontmatter") {
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (mask[i]) continue;
      if (matchHeadingBoundary(lines[i] ?? "")) {
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
      const m = matchHeadingBoundary(lines[i] ?? "");
      if (m && m.title.toLowerCase() === want) matches.push({ index: i, level: m.level });
    }
    if (matches.length === 0) return { found: false, reason: "not_found" };
    if (matches.length > 1)
      return { found: false, reason: "ambiguous", matchLines: matches.map((m) => m.index + 1) };
    const { index: hi, level } = matches[0] as { index: number; level: number };
    let end = lines.length;
    for (let j = hi + 1; j < lines.length; j++) {
      if (mask[j]) continue;
      const m = matchHeadingBoundary(lines[j] ?? "");
      if (m && m.level <= level) {
        end = j;
        break;
      }
    }
    return { found: true, startIndex: hi, endIndex: end, headingLevel: level };
  }

  // block — GH #926 review round 2 (N2) / M5: a `^id` marker that only exists as sample text
  // inside a fenced code block is never a candidate, for resolution OR ambiguity counting.
  const re = new RegExp(`(?:^|\\s)\\^${escapeRegExp(anchor.block_id)}\\s*$`);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
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
  const sectionText = lines.slice(span.startIndex, span.endIndex).join(eol);
  const searchableText = excludeTrailing
    ? sectionText.slice(0, sectionText.length - excludeTrailing.length)
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
  const nextSection = nextNormalizedSection.split("\n").join(eol) + excludeTrailing;
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
): PatchResult {
  const r = resolveSection(body, { type: "frontmatter" });
  const lines = body.split(/\r?\n/);
  const end = r.found ? r.endIndex : lines.length;
  return splice(lines, op, 0, 0, end, content, eol);
}
