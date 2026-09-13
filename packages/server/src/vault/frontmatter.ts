// YAML frontmatter parse/serialize. Body bytes are preserved verbatim. Frontmatter
// key order is preserved; existing keys keep their position, new keys append.
//
// Fidelity: serializeNote, given the ORIGINAL frontmatter text (parseNote().rawFrontmatter),
// rewrites the block as a LINE LIST — every source line no changed or removed key owns is
// emitted byte-for-byte, so YAML scalar quirks (leading-zero strings like zip: 01234,
// trailing-zero versions like 1.10, hex/octal/sci values), standalone comments, inline
// comments and blank lines all survive. Only added/changed keys are re-serialized; a removed
// key's lines are dropped, leaving exactly one line break between its neighbours. A
// frontmatter-unchanged write (e.g. a body-only patch) keeps the block verbatim; without the
// original it falls back to a plain stringify (new notes). NOTE: the yaml Document API alone
// still canonicalizes leading-zero integers, so SOURCE slicing (not doc.toString) is what
// guarantees fidelity.
import { isDeepStrictEqual } from "node:util";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import YAML, { isMap, isNode, isScalar, YAMLParseError } from "yaml";

// THE-1040 C1: the opening delimiter's own line break gets its own capture group so parseNote
// can hand it straight to a caller — the ONLY reliable EOL signal for a block whose content
// never happens to carry an internal line break (one key, one comment).
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
  /** THE-1043: the closing "---" ended the file with no line break of its own — an empty body
   *  cannot tell that apart from a note that does end in one. Pass it to serializeNote's
   *  `frontmatterAtEof`, or a round-trip write appends a newline the note never had. */
  frontmatterAtEof: boolean;
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
      frontmatterAtEof: false,
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
    frontmatterAtEof: (m[3] ?? "") === "",
  };
}

/** Serialize a single key/value entry (used for added/changed keys). */
function emitEntry(key: string, value: unknown): string {
  return YAML.stringify({ [key]: value }, { lineWidth: 0 }).replace(/\n+$/, "");
}

/** THE-1040 X1: normalize a slice's line breaks to the block's own EOL, dropping a trailing empty
 *  line — or a stray "\r" a YAML node's range boundary can leave just short of its own line
 *  terminator on a CRLF source — so re-joining it with a sibling never doubles a terminator. */
function normalizeSlice(text: string, eol: string): string {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join(eol).replace(/\r+$/, "");
}

/** Build the frontmatter YAML body. With original (the verbatim source), the block is rewritten
 *  as a LINE LIST: every line no changed/removed key owns is emitted verbatim (comments, blank
 *  lines, unchanged keys with their inline comments), a changed key replaces its own lines, a
 *  removed key's lines are dropped. Without an original, plain-stringify the object. */
function emitFrontmatter(
  next: Frontmatter,
  original: string | null | undefined,
  eol: string,
): string {
  if (original && original.length > 0) {
    try {
      const doc = YAML.parseDocument(original);
      const map = doc.contents;
      // THE-1043: a block of pure comments parses to NO contents at all, but its lines are still
      // content — it walks the same line list with an empty key set, so adding a key to it (a
      // first add_tag) appends rather than replacing the block.
      const commentOnly = map === null && original.trim().length > 0;
      const prev = commentOnly ? {} : doc.toJS();
      if ((isMap(map) || commentOnly) && prev && typeof prev === "object" && !Array.isArray(prev)) {
        const prevObj = prev as Frontmatter;
        // THE-1040 X3: no stripping — parseNote's capture already excludes the ONE line
        // break immediately before the closing "---" (its lazy match stops there), so
        // `original` is already the exact text to re-wrap; stripping trailing "\r"/"\n"
        // here used to eat a no-op merge's own trailing blank lines.
        if (isDeepStrictEqual(prevObj, next)) return original;
        const lines = sourceLines(original);
        const groups = keyGroups(original, lines, isMap(map) ? map : null);
        if (groups) {
          const out: string[] = [];
          const seen = new Set<string>();
          for (const g of groups) for (const s of g.keys) seen.add(s.key);
          let gi = 0;
          for (let i = 0; i < lines.length; ) {
            const g = groups[gi];
            if (g && g.firstLine === i) {
              out.push(...emitGroup(g, original, lines, prevObj, next, eol));
              i = g.lastLine + 1;
              gi++;
              continue;
            }
            const line = lines[i];
            if (line) out.push(original.slice(line.start, line.end));
            i++;
          }
          for (const k of Object.keys(next))
            if (!seen.has(k)) out.push(normalizeSlice(emitEntry(k, next[k]), eol));
          if (out.length > 0) return out.join(eol);
        }
      }
    } catch {}
  }
  return YAML.stringify(next, { lineWidth: 0 }).replace(/\n+$/, "");
}

/** The lines of one group. A group that OWNS its lines keeps them verbatim while its key is
 *  unchanged (inline comment and all), re-emits the key in their place when it changed, and
 *  drops them when it was removed. A group that owns nothing — a root flow mapping, braces and
 *  all — is rebuilt key by key instead: a changed root flow mapping is therefore re-emitted in
 *  BLOCK style and its flow style is not round-tripped (an UNTOUCHED one never reaches here —
 *  emitFrontmatter returns the block verbatim). An unchanged key splices back from its own node
 *  range, but only when it HAS a value node: `{a, b: 2}`'s bare `a` ranges over the key name
 *  alone, which is not a mapping entry on a line of its own, so it re-serializes instead. */
function emitGroup(
  group: LineGroup,
  text: string,
  lines: SourceLine[],
  prevObj: Frontmatter,
  next: Frontmatter,
  eol: string,
): string[] {
  const kept = group.keys.filter((s) => s.key in next);
  const rebuild = (s: KeySpan): string =>
    s.spliceable && isDeepStrictEqual(prevObj[s.key], next[s.key])
      ? normalizeSlice(text.slice(s.start, s.end), eol)
      : normalizeSlice(emitEntry(s.key, next[s.key]), eol);
  if (!group.ownsLines) {
    const out = kept.map(rebuild);
    const at = out.length - 1;
    const end = out[at];
    if (group.tail && end !== undefined) out[at] = `${end}${group.tail}`;
    return out;
  }
  const only = kept[0];
  if (!only) return [];
  if (!isDeepStrictEqual(prevObj[only.key], next[only.key]))
    return [normalizeSlice(emitEntry(only.key, next[only.key]), eol)];
  return lines.slice(group.firstLine, group.lastLine + 1).map((l) => text.slice(l.start, l.end));
}

/** Fallback delimiter EOL for a caller with no captured `frontmatterEol` (a brand-new note with
 *  nothing to follow) — inferred from whatever CRLF signal the raw block or body happens to
 *  carry. `serializeNote` prefers the authoritative `options.frontmatterEol` whenever given. */
function delimiterEol(original: string | null | undefined, body: string): string {
  return original?.includes("\r\n") || body.includes("\r\n") ? "\r\n" : "\n";
}

/** One source line's [start, end), the end EXCLUDING its terminator — a CRLF block's "\r" never
 *  reaches an emitted line, so it can never double up against the joining eol. */
interface SourceLine {
  start: number;
  end: number;
}

/** A mapping key, the lines it occupies, and its own [start, end) node range. */
interface KeySpan {
  key: string;
  start: number;
  end: number;
  firstLine: number;
  lastLine: number;
  ownsLines: boolean;
  spliceable: boolean;
}

/** Lines rewritten as a unit: one block-style key, or every key of a shared line. `tail` is what
 *  the last line carries OUTSIDE the rewritten node — an inline comment after a flow mapping's
 *  closing brace — re-attached to the rebuilt last line rather than swallowed. */
interface LineGroup {
  firstLine: number;
  lastLine: number;
  keys: KeySpan[];
  ownsLines: boolean;
  tail?: string;
}

/** Split the raw block into lines (its capture carries no trailing break, so the last entry is
 *  always the block's last line of content). */
function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  for (let start = 0; ; ) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      lines.push({ start, end: text.length });
      return lines;
    }
    lines.push({ start, end: nl > start && text[nl - 1] === "\r" ? nl - 1 : nl });
    start = nl + 1;
  }
}

function lineIndexAt(lines: SourceLine[], offset: number): number {
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i];
    if (line && offset >= line.start) return i;
  }
  return 0;
}

/** The [firstLine, lastLine] a node's [start, end) byte range occupies. A multi-line node (a list,
 *  a block scalar, a braced flow collection) commonly ends just PAST its own trailing break, at
 *  the START of the next line — which belongs to whatever follows, not to it. */
function lineSpanOf(lines: SourceLine[], start: number, end: number): [number, number] {
  const firstLine = lineIndexAt(lines, start);
  const endLine = lineIndexAt(lines, end);
  const endAt = lines[endLine];
  if (endAt && end === endAt.start && endLine > firstLine) return [firstLine, endLine - 1];
  return [firstLine, endLine];
}

/**
 * THE-1043: map every key to the lines its node covers, and to whether it OWNS them. Ownership
 * means block style — nothing but whitespace before the key on its first line, nothing but
 * whitespace or a comment (which belongs to the key) after its value on the last. Keys whose
 * line ranges touch form one group, the unit the emitter keeps, rebuilds or drops — `map.items`
 * is a parsed document's own mapping order, so groups come out in ascending line order. Null = a
 * non-scalar key, for which the caller falls back to a plain stringify.
 *
 * A FLOW root (`{a: 1, b: 2}`, single- or multi-line) is the exception: no key owns a line there,
 * and the braces belong to no key — left as lines of their own they would wrap block-style
 * re-emitted entries in stray `{`/`}`. The whole collection is one group, braces included,
 * rebuilt from the changed mapping (`tail` keeps what follows the closing one).
 */
function keyGroups(
  text: string,
  lines: SourceLine[],
  map: { items: Array<{ key: unknown; value: unknown }>; flow?: boolean; range?: unknown } | null,
): LineGroup[] | null {
  const groups: LineGroup[] = [];
  for (const item of map?.items ?? []) {
    const kNode = item.key;
    if (!isScalar(kNode) || !kNode.range) return null;
    const vr = isNode(item.value) ? item.value.range : null;
    const start = kNode.range[0];
    const end = vr ? vr[1] : kNode.range[1];
    const [firstLine, lastLine] = lineSpanOf(lines, start, end);
    const first = lines[firstLine];
    const last = lines[lastLine];
    if (!first || !last) return null;
    const tail = text.slice(Math.min(end, last.end), last.end).trimStart();
    const span: KeySpan = {
      key: String(kNode.value),
      start,
      end,
      firstLine,
      lastLine,
      ownsLines:
        text.slice(first.start, start).trim() === "" && (tail === "" || tail.startsWith("#")),
      spliceable: vr !== null,
    };
    const prev = groups[groups.length - 1];
    if (prev && span.firstLine <= prev.lastLine) {
      prev.lastLine = Math.max(prev.lastLine, span.lastLine);
      prev.keys.push(span);
      prev.ownsLines = false;
    } else {
      groups.push({
        firstLine: span.firstLine,
        lastLine: span.lastLine,
        keys: [span],
        ownsLines: span.ownsLines,
      });
    }
  }
  if (!map?.flow) return groups;
  const range = map.range;
  if (!Array.isArray(range) || typeof range[0] !== "number" || typeof range[1] !== "number")
    return null;
  const [firstLine, lastLine] = lineSpanOf(lines, range[0], range[1]);
  const last = lines[lastLine];
  // Anything after the closing brace on its line — an inline comment — is outside the collection
  // and belongs to no key, so the rebuild must not eat it. The opening side can only be leading
  // whitespace (a "#" there would comment the brace out), and re-attaching THAT would indent the
  // rebuilt root out of the mapping, so it is dropped on purpose.
  const tail = last ? text.slice(Math.min(range[1], last.end), last.end) : "";
  return [{ firstLine, lastLine, keys: groups.flatMap((g) => g.keys), ownsLines: false, tail }];
}

/**
 * THE-1040 F1/C2/C4/O1: what (if anything) of a raw block survives once the caller's mapping is
 * empty. Comments are content, never discarded just because every real key is gone (or never
 * existed) — but an INLINE comment belongs to its key, so only a full-line comment or a blank
 * line can survive. A block with no real mapping at all (comment-only, e.g. a note untouched by a
 * no-op `merge`) comes back byte-for-byte — `.trim()` decides only whether to keep it, never what
 * gets returned. Otherwise the lines its keys owned are dropped, the rest rejoined on the block's
 * own `eol`, and null (nothing survived) tells the caller to drop the delimiters.
 */
function survivingComments(original: string | null | undefined, eol: string): string | null {
  if (!original) return null;
  const keep = (text: string): string | null => (text.trim().length > 0 ? text : null);
  let doc: ReturnType<typeof YAML.parseDocument>;
  try {
    doc = YAML.parseDocument(original);
  } catch {
    return keep(original);
  }
  const map = doc.contents;
  if (!isMap(map)) return keep(original);
  const lines = sourceLines(original);
  const groups = keyGroups(original, lines, map);
  if (!groups) return keep(original);
  const owned = new Set<number>();
  for (const g of groups) for (let i = g.firstLine; i <= g.lastLine; i++) owned.add(i);
  return keep(
    lines
      .filter((_, i) => !owned.has(i))
      .map((l) => original.slice(l.start, l.end))
      .join(eol),
  );
}

export interface SerializeNoteOptions {
  /** THE-1040 C1: parseNote's captured `frontmatterEol`. Preferred over content-based
   *  detection whenever a note was actually parsed (every round-trip write) — omit only
   *  when building a brand-new note with no source to follow. */
  frontmatterEol?: FrontmatterEol | null;
  /** THE-1043: parseNote's captured `frontmatterAtEof`. Keeps a closing "---" that ended the
   *  file at EOF instead of gaining a trailing line break on every round-trip write. */
  frontmatterAtEof?: boolean;
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
  // THE-1043: a closing "---" that ended the file stays at EOF. Guarded on an empty body, so a
  // caller that keeps the flag while supplying new body text still gets its separator.
  const close = options?.frontmatterAtEof && body.length === 0 ? "---" : `---${eol}`;
  // An empty/absent mapping covers three shapes a caller may pass: `null` (no frontmatter
  // block existed, or update_frontmatter/remove_tag explicitly emptied it), and `{}` (an
  // object that genuinely has zero keys, e.g. parseNote's result for a comment-only
  // block). All three route through survivingComments, which tells a truly-empty block
  // apart from one that still carries comments worth keeping.
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    const kept = survivingComments(originalFrontmatter, eol);
    if (kept !== null) return `---${eol}${kept}${eol}${close}${body}`;
    return body;
  }
  return `---${eol}${emitFrontmatter(frontmatter, originalFrontmatter, eol)}${eol}${close}${body}`;
}
