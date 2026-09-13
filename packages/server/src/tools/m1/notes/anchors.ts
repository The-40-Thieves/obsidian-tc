// THE-1038 / GH #927: anchor resolution used to be private to write.ts (patch_note) because
// nothing else in the notes domain needed it. read_note's section read (added in a later commit
// on this branch) needs the exact same heading/block/preamble resolution patch_note already
// computes on every call, so it moved here — one place to fix the heading-scan defects (#922,
// #926) instead of two. Pure functions over strings: no filesystem, no vault types.

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

export type SectionResolution = ({ found: true } & SectionSpan) | { found: false };

/** Resolve `anchor` against `body`'s first match. Pure: never throws, never touches disk. */
export function resolveSection(body: string, anchor: ResolvedAnchor): SectionResolution {
  const lines = body.split(/\r?\n/);

  if (anchor.type === "frontmatter") {
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (HEADING.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }
    return { found: true, startIndex: 0, endIndex: end };
  }

  if (anchor.type === "heading") {
    const want = anchor.heading.trim().toLowerCase();
    let hi = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = HEADING.exec(lines[i] ?? "");
      if (m && (m[2] ?? "").trim().toLowerCase() === want) {
        hi = i;
        level = (m[1] ?? "").length;
        break;
      }
    }
    if (hi < 0) return { found: false };
    let end = lines.length;
    for (let j = hi + 1; j < lines.length; j++) {
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
  let bi = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) {
      bi = i;
      break;
    }
  }
  if (bi < 0) return { found: false };
  let start = bi;
  while (start > 0) {
    const prev = lines[start - 1] ?? "";
    if (prev.trim() === "" || HEADING.test(prev)) break;
    start--;
  }
  return { found: true, startIndex: start, endIndex: bi + 1 };
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

/** Insert/replace content relative to a heading section. Returns null if the
 *  heading is not found. The section spans the heading line to the next heading
 *  of the same or higher level (or EOF). `eol` preserves the note's line ending. */
export function patchByHeading(
  body: string,
  op: "append" | "prepend" | "replace",
  target: string,
  content: string,
  eol: string,
): PatchResult | null {
  const r = resolveSection(body, { type: "heading", heading: target });
  if (!r.found) return null;
  const lines = body.split(/\r?\n/);
  return splice(lines, op, r.startIndex + 1, r.startIndex + 1, r.endIndex, content, eol);
}

/** THE-198: insert/replace content relative to a block reference (`^block-id`).
 *  The block spans backward from the `^id` line to the paragraph start (a blank
 *  line, a heading, or body start). Returns null when the block id is absent. */
export function patchByBlock(
  body: string,
  op: "append" | "prepend" | "replace",
  blockId: string,
  content: string,
  eol: string,
): PatchResult | null {
  const r = resolveSection(body, { type: "block", block_id: blockId });
  if (!r.found) return null;
  const lines = body.split(/\r?\n/);
  return splice(lines, op, r.startIndex, r.startIndex, r.endIndex, content, eol);
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
