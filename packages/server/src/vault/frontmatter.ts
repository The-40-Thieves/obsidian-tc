// YAML frontmatter parse/serialize. Body bytes are preserved verbatim. Frontmatter
// key order is preserved; existing keys keep their position, new keys append.
//
// Fidelity: serializeNote, given the ORIGINAL frontmatter text
// (parseNote().rawFrontmatter), emits every key the caller did not change
// byte-for-byte by slicing it back out of the source, so YAML scalar quirks survive
// (leading-zero strings like zip: 01234, trailing-zero versions like 1.10, hex/octal/
// sci values). Only added/changed keys are re-serialized; deleted keys are dropped. A
// frontmatter-unchanged write (e.g. a body-only patch) keeps the block verbatim,
// comments included. Without the original it falls back to a plain stringify (new
// notes). NOTE: the yaml Document API alone still canonicalizes leading-zero integers,
// so per-key SOURCE slicing (not doc.toString) is what guarantees fidelity.
import { isDeepStrictEqual } from "node:util";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import YAML, { isMap, isNode, isScalar, YAMLParseError } from "yaml";

// THE-1040 C1: the opening delimiter's own line break gets its own capture group so
// parseNote can hand it straight to a caller — the ONLY reliable EOL signal for a block
// whose content never happens to carry an internal line break (one key, one comment).
const FRONTMATTER = /^---(\r?\n)([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export type Frontmatter = Record<string, unknown>;
export type FrontmatterEol = "\n" | "\r\n";

export interface ParsedNote {
  frontmatter: Frontmatter | null;
  body: string;
  hasFrontmatter: boolean;
  /** Verbatim YAML text from inside the block (null when absent). Pass it back to
   *  serializeNote so keys the caller did not change keep their exact source. */
  rawFrontmatter: string | null;
  /** THE-1040 C1: the line ending the OPENING "---" actually used, captured at parse
   *  time — independent of whatever the YAML content or body happen to contain. Pass to
   *  serializeNote's `frontmatterEol` option on every round-trip write; null when there
   *  was no frontmatter block to have one. */
  frontmatterEol: FrontmatterEol | null;
}

/**
 * Split a note into its frontmatter object (if any) and verbatim body.
 *
 * `path` is optional and purely diagnostic — parseNote stays a pure parsing primitive over
 * `raw` (some callers round-trip an in-memory buffer with no file behind it, e.g.
 * parseEntityNote's graph-integrity check). THE-823: every production call site that reads a
 * note off disk DOES have a path in scope by the time it calls parseNote, so all of them now
 * pass one — a caller with no path is the deliberate exception, not a gap.
 */
export function parseNote(raw: string, path?: string): ParsedNote {
  const m = FRONTMATTER.exec(raw);
  if (!m)
    return {
      frontmatter: null,
      body: raw,
      hasFrontmatter: false,
      rawFrontmatter: null,
      frontmatterEol: null,
    };
  let fm: Frontmatter;
  try {
    const parsed = YAML.parse(m[2] ?? "") as unknown;
    fm =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Frontmatter) : {};
  } catch (e) {
    // THE-823: a bare `catch` discarded the YAML parser's own error — including the line/column it
    // already computed (YAMLParseError.message always ends its first line with "at line N, column
    // M:") — before anything downstream could read it, leaving "frontmatter is not valid YAML" as
    // the caller's entire diagnostic. That half shipped first; this half threads the note PATH
    // through too, so a large-vault boot reconcile names the offending file instead of leaving the
    // reporter to bisect the vault by hand.
    const detail = e instanceof YAMLParseError ? e.message.split("\n")[0] : undefined;
    const where = path ? ` in "${path}"` : "";
    throw err.invalidInput(
      detail
        ? `frontmatter is not valid YAML${where}: ${detail}`
        : `frontmatter is not valid YAML${where}`,
      path ? { path } : undefined,
    );
  }
  return {
    frontmatter: fm,
    body: raw.slice(m[0].length),
    hasFrontmatter: true,
    rawFrontmatter: m[2] ?? "",
    frontmatterEol: m[1] === "\r\n" ? "\r\n" : "\n",
  };
}

/** Serialize a single key/value entry (used for added/changed keys). */
function emitEntry(key: string, value: unknown): string {
  return YAML.stringify({ [key]: value }, { lineWidth: 0 }).replace(/\n+$/, "");
}

/** THE-1040 X1: normalize a raw slice's line breaks to the block's own EOL, and drop a
 *  trailing empty line — or a stray "\r" a YAML node's range boundary can leave just
 *  short of its own line terminator on a CRLF source (observed on a multi-line block
 *  value's range end) — so splicing an unchanged key's slice back in and joining it with
 *  a sibling entry via the block's own eol (C3) never doubles up a line terminator. */
function normalizeSlice(text: string, eol: string): string {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join(eol).replace(/\r+$/, "");
}

/**
 * Build the frontmatter YAML body. With original (the verbatim source), unchanged
 * keys are spliced back from the source byte-for-byte and only added/changed keys are
 * re-serialized; without it, plain-stringify the object. `eol` (THE-1040 C3) joins the
 * entries — a CRLF note's untouched keys must stay separated by CRLF, not a hardcoded LF.
 */
function emitFrontmatter(
  next: Frontmatter,
  original: string | null | undefined,
  eol: string,
): string {
  if (original && original.length > 0) {
    try {
      const doc = YAML.parseDocument(original);
      const map = doc.contents;
      const prev = doc.toJS();
      if (isMap(map) && prev && typeof prev === "object" && !Array.isArray(prev)) {
        const prevObj = prev as Frontmatter;
        // THE-1040 X3: no stripping — parseNote's capture already excludes the ONE line
        // break immediately before the closing "---" (its lazy match stops there), so
        // `original` is already the exact text to re-wrap; stripping trailing "\r"/"\n"
        // here used to eat a no-op merge's own trailing blank lines.
        if (isDeepStrictEqual(prevObj, next)) return original;
        const entries: string[] = [];
        const seen = new Set<string>();
        for (const item of map.items) {
          const kNode = item.key;
          if (!isScalar(kNode)) return YAML.stringify(next, { lineWidth: 0 }).replace(/\n+$/, "");
          const k = String(kNode.value);
          seen.add(k);
          if (!(k in next)) continue;
          const vNode = item.value;
          const kr = kNode.range;
          const vr = isNode(vNode) ? vNode.range : null;
          if (isDeepStrictEqual(prevObj[k], next[k]) && kr && vr) {
            entries.push(normalizeSlice(original.slice(kr[0], vr[1]), eol));
          } else {
            entries.push(emitEntry(k, next[k]));
          }
        }
        for (const k of Object.keys(next)) if (!seen.has(k)) entries.push(emitEntry(k, next[k]));
        if (entries.length > 0) return entries.join(eol);
      }
    } catch {}
  }
  return YAML.stringify(next, { lineWidth: 0 }).replace(/\n+$/, "");
}

/** Fallback delimiter EOL for a caller with no captured `frontmatterEol` (a brand-new
 *  note with nothing to follow, or a caller that predates THE-1040 C1) — inferred from
 *  whatever CRLF signal the raw block or body happens to carry. `serializeNote` prefers
 *  the authoritative `options.frontmatterEol` over this whenever it's given. */
function delimiterEol(original: string | null | undefined, body: string): string {
  return original?.includes("\r\n") || body.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Expand a node's [start, end) byte range to the FULL source line(s) it occupies: back
 * up `start` to the beginning of its line, and extend `end` to the end of its line
 * (through the trailing "\n" when one follows). A node whose line has no trailing "\n"
 * (the raw block's last line — parseNote's capture never includes one) instead pulls in
 * the PRECEDING "\n", so removing it collapses cleanly rather than leaving a stray blank
 * line at the deletion point. THE-1040 O1: this is what keeps an INLINE trailing comment
 * (`tags: [x] # note`) or a multi-line value (a list, a block scalar) glued to the key
 * being removed, rather than orphaning fragments of it as a "surviving" line.
 */
function lineSpan(text: string, start: number, end: number): [number, number] {
  const prevNl = text.lastIndexOf("\n", start - 1);
  let lineStart = prevNl === -1 ? 0 : prevNl + 1;
  const nextNl = text.indexOf("\n", end);
  let lineEnd: number;
  if (nextNl === -1) {
    lineEnd = text.length;
    if (lineStart > 0) lineStart -= 1;
  } else {
    lineEnd = nextNl + 1;
  }
  return [lineStart, lineEnd];
}

/**
 * THE-1040 F1/C2/C4/O1: what (if anything) of a raw frontmatter block survives once the
 * caller's mapping is empty — comments are content, never silently discarded just
 * because every real key is gone (or never existed), but an INLINE comment belongs to
 * its key and goes with it (only a FULL-LINE comment, or a blank line, can survive).
 * Three outcomes:
 *  - the raw block has no real YAML mapping at all (comment-only, e.g. a note untouched
 *    by a no-op `merge`) — returned byte-for-byte unchanged; `.trim()` decides only
 *    whether to keep it, never what gets returned (C2: an interior blank line survives).
 *  - the raw block HAD real keys, now all gone (an update/remove emptied it) — every
 *    key's FULL SOURCE LINE(S) are stripped out (O1: the whole line span, not just the
 *    node's own byte range, so an inline trailing comment and a multi-line value go with
 *    the key that owned them) and whatever text remains — untouched, blank lines and all
 *    — is kept as-is.
 *  - nothing survives either way (a blank/whitespace-only block, or one with only keys
 *    and no comments) — null, so the caller drops the delimiters entirely.
 */
function survivingComments(original: string | null | undefined): string | null {
  if (!original) return null;
  let doc: ReturnType<typeof YAML.parseDocument>;
  try {
    doc = YAML.parseDocument(original);
  } catch {
    return original.trim().length > 0 ? original : null;
  }
  const map = doc.contents;
  if (!isMap(map)) return original.trim().length > 0 ? original : null;
  const spans: Array<[number, number]> = [];
  for (const item of map.items) {
    const kNode = item.key;
    const kr = isScalar(kNode) ? kNode.range : null;
    if (!kr) return original.trim().length > 0 ? original : null;
    const vNode = item.value;
    const vr = isNode(vNode) ? vNode.range : null;
    spans.push(lineSpan(original, kr[0], vr ? vr[1] : kr[1]));
  }
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    out += original.slice(cursor, Math.max(cursor, start));
    cursor = Math.max(cursor, end);
  }
  out += original.slice(cursor);
  return out.trim().length > 0 ? out : null;
}

export interface SerializeNoteOptions {
  /** THE-1040 C1: parseNote's captured `frontmatterEol`. Preferred over content-based
   *  detection whenever a note was actually parsed (every round-trip write) — omit only
   *  when building a brand-new note with no source to follow. */
  frontmatterEol?: FrontmatterEol | null;
}

/** Re-emit a note from frontmatter + body. Pass originalFrontmatter to preserve
 *  untouched keys exactly, and options.frontmatterEol (parseNote's own field) so the
 *  delimiters keep the note's actual line ending rather than an inferred one. */
export function serializeNote(
  frontmatter: Frontmatter | null,
  body: string,
  originalFrontmatter?: string | null,
  options?: SerializeNoteOptions,
): string {
  const eol = options?.frontmatterEol ?? delimiterEol(originalFrontmatter, body);
  // An empty/absent mapping covers three shapes a caller may pass: `null` (no frontmatter
  // block existed, or update_frontmatter/remove_tag explicitly emptied it), and `{}` (an
  // object that genuinely has zero keys, e.g. parseNote's result for a comment-only
  // block). All three route through survivingComments, which tells a truly-empty block
  // apart from one that still carries comments worth keeping.
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    const kept = survivingComments(originalFrontmatter);
    if (kept !== null) return `---${eol}${kept}${eol}---${eol}${body}`;
    return body;
  }
  return `---${eol}${emitFrontmatter(frontmatter, originalFrontmatter, eol)}${eol}---${eol}${body}`;
}
