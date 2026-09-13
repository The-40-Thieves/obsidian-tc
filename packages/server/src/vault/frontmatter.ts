// YAML frontmatter parse/serialize. Body bytes are preserved verbatim. Frontmatter
// key order is preserved; existing keys keep their position, new keys append.
//
// Fidelity: serializeNote, given the ORIGINAL frontmatter text (parseNote().rawFrontmatter),
// rewrites the block as a LINE LIST — every source line no changed or removed key owns is emitted
// byte-for-byte, so YAML scalar quirks (leading-zero strings like zip: 01234, trailing-zero
// versions like 1.10, hex/octal/sci values), standalone comments, inline comments and blank lines
// all survive. Only added/changed keys are re-serialized; a removed key's lines are dropped,
// leaving exactly one line break between its neighbours. A frontmatter-unchanged write keeps the
// block verbatim; without the original it falls back to a plain stringify (new notes). SOURCE
// slicing (not doc.toString) is what guarantees fidelity — the Document API alone canonicalizes
// leading-zero integers; a block carrying an ALIAS is the one exception (emitViaDocument).
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
  /** THE-1040 C1: the line ending the OPENING "---" actually used, captured at parse time —
   *  independent of what the YAML content or body contain. Pass to serializeNote's `frontmatterEol`
   *  on every round-trip write; null when there was no frontmatter block to have one. */
  frontmatterEol: FrontmatterEol | null;
  /** THE-1043: the closing "---" ended the file with no line break of its own — an empty body
   *  cannot tell that apart from a note that does end in one. Pass it to serializeNote's
   *  `frontmatterAtEof`, or a round-trip write appends a newline the note never had. */
  frontmatterAtEof: boolean;
}

/** Split a note into its frontmatter object (if any) and verbatim body. `path` is optional and
 *  purely diagnostic — parseNote stays a pure parsing primitive over `raw` (some callers round-trip
 *  an in-memory buffer with no file behind it, e.g. parseEntityNote's graph-integrity check).
 *  THE-823: every call site that reads a note off disk passes one. */
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
    // THE-823: the parser's own message carries the line/column it already computed (its first
    // line always ends "at line N, column M:"), and the note PATH goes with it — a bare `catch`
    // left a large-vault boot reconcile with no way to name the offending file.
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

/** Stringifier output as block lines joined on the block's own eol. THE-1044: only the ONE
 *  terminating break it always appends goes — a `|+` scalar's trailing blank lines are the VALUE. */
function blockText(text: string, eol: string): string {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return eol === "\n" ? body : body.split("\n").join(eol);
}

/** Serialize a single key/value entry (used for added/changed keys). */
function emitEntry(key: string, value: unknown, eol: string): string {
  return blockText(YAML.stringify({ [key]: value }, { lineWidth: 0 }), eol);
}

/** THE-1044: the separator between the block's last line and the closing "---" is one block EOL,
 *  never taken from a value. A block scalar's trailing newlines are LINES, and parseNote's capture
 *  stops one break short of that delimiter, so a block ending in a keep-chomp (`|+`) scalar reads
 *  one newline light. Decided by ROUND TRIP, so a merely-blank line never gains a twin. */
function closeBlock(text: string, next: Frontmatter, eol: string): string {
  if (!text.endsWith(eol)) return text;
  try {
    if (isDeepStrictEqual(YAML.parse(text), next)) return text;
    return isDeepStrictEqual(YAML.parse(text + eol), next) ? text + eol : text;
  } catch {
    return text;
  }
}

/** THE-1044: a block carrying any alias is edited as a DOCUMENT, not as a line list — the library
 *  keeps `&anchor`/`*alias` and node comments across set/delete, where re-emitting one key alone
 *  leaves a sibling's `*x` on an anchor that is gone and the note stops parsing. The cost is byte
 *  fidelity for the WHOLE block (an untouched `zip: 01234` comes back quoted); correctness first.
 *  Null = no alias, use the line list. */
function emitViaDocument(
  doc: ReturnType<typeof YAML.parseDocument>,
  prevObj: Frontmatter,
  next: Frontmatter,
  eol: string,
): string | null {
  if (!hasAlias(doc)) return null;
  const changed = (k: string) => !(k in prevObj) || !isDeepStrictEqual(prevObj[k], next[k]);
  const doomed = Object.keys(prevObj).filter((k) => !(k in next) || changed(k));
  materializeAliases(doc, doomed);
  for (const k of Object.keys(prevObj))
    if (!(k in next)) for (const node of docKeys(doc, k)) doc.delete(node);
  for (const k of Object.keys(next)) {
    if (!changed(k)) continue;
    // THE-1044: two of a key's pairs that now stringify alike are "Map keys must be unique" on
    // the next read, so only the pair the reader resolves survives. Materialization has already
    // copied every anchor out from under the others, so dropping them strands nothing.
    const nodes = docKeys(doc, k);
    for (const shadowed of nodes.slice(0, -1)) doc.delete(shadowed);
    doc.set(nodes[nodes.length - 1] ?? k, next[k]);
  }
  for (const k of doomed) dropOrphanAnchor(doc, k);
  return blockText(doc.toString({ lineWidth: 0 }), eol);
}

/** Whether the document holds an alias — any of them, or one naming `anchor`. */
function hasAlias(doc: ReturnType<typeof YAML.parseDocument>, anchor?: string): boolean {
  let found = false;
  YAML.visit(doc, {
    Alias(_k, node) {
      if (anchor !== undefined && node.source !== anchor) return undefined;
      found = true;
      return YAML.visit.BREAK;
    },
  });
  return found;
}

/** THE-1044: the document's OWN key nodes for a caller key, matched on their string form — a
 *  mapping keyed `1:`/`true:` arrives as the JS string, which get/set/delete compare against the
 *  key node's `value`, so the pair was missed entirely. There can be SEVERAL (`1:`, `'1':` and an
 *  alias key are distinct YAML keys collapsing to one JS key) and the reader sees the LAST — so a
 *  set follows the last and a remove drops them all, or a shadowed duplicate resurfaces. */
function docKeys(doc: ReturnType<typeof YAML.parseDocument>, key: string): unknown[] {
  const map = doc.contents;
  if (!isMap(map)) return [];
  const found: unknown[] = [];
  for (const pair of map.items) {
    const k = (pair as { key?: unknown }).key;
    if (String(isScalar(k) ? k.value : k) === key) found.push(k);
  }
  return found;
}

/** The pair the reader resolves `key` to — the last match, or the key itself when the document has
 *  none, which is what appends a genuinely new one. */
function docKey(doc: ReturnType<typeof YAML.parseDocument>, key: string): unknown {
  const found = docKeys(doc, key);
  return found.length > 0 ? found[found.length - 1] : key;
}

/** THE-1044: `doc.set` mutates a Scalar in place, so a scalar-to-scalar change kept the old node's
 *  `&anchor` while a collection-to-scalar change dropped it. An anchor on a CHANGED value goes once
 *  nothing aliases it; one on an untouched key is left as written. */
function dropOrphanAnchor(doc: ReturnType<typeof YAML.parseDocument>, key: string): void {
  const node = doc.get(docKey(doc, key), true);
  if (!isNode(node)) return;
  YAML.visit(node, {
    Node(_k, n) {
      if (n.anchor && !hasAlias(doc, n.anchor)) n.anchor = undefined;
    },
  });
}

/** Replace every alias to an anchor defined inside `keys` — the values about to be replaced or
 *  dropped — with a copy of what it resolves to TODAY, comments carried over: the aliasing key
 *  keeps the value the caller's mapping gives it. An anchor no doomed key covers is left alone. */
function materializeAliases(doc: ReturnType<typeof YAML.parseDocument>, keys: string[]): void {
  const anchors = new Set<string>();
  for (const key of keys)
    for (const k of docKeys(doc, key)) {
      const node = doc.get(k, true);
      if (!isNode(node)) continue;
      YAML.visit(node, {
        Node(_k, n) {
          if (n.anchor) anchors.add(n.anchor);
        },
      });
    }
  if (anchors.size === 0) return;
  YAML.visit(doc, {
    Alias(_k, node) {
      if (!anchors.has(node.source)) return undefined;
      const src = node.resolve(doc);
      if (!src) return undefined;
      const copy = doc.createNode(src.toJS(doc));
      copy.comment = node.comment;
      copy.commentBefore = node.commentBefore;
      copy.spaceBefore = node.spaceBefore;
      return copy;
    },
  });
}

/** THE-1040 X1: normalize a SOURCE slice's line breaks to the block's own EOL, dropping a trailing
 *  empty line (or a stray "\r" a node range can leave short of its terminator on CRLF) so
 *  re-joining with a sibling never doubles one. Never used on emitted text — see blockText. */
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
        // THE-1040 X3: no stripping — parseNote's capture already excludes the ONE line break
        // before the closing "---", so `original` is the exact text to re-wrap.
        if (isDeepStrictEqual(prevObj, next)) return original;
        const viaDoc = isMap(map) ? emitViaDocument(doc, prevObj, next, eol) : null;
        if (viaDoc !== null) return closeBlock(viaDoc, next, eol);
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
              // THE-1044: an emitted keep-chomp entry (the only part that ends on a blank line)
              // ABSORBS the blank lines after it, so a separator the source kept between this key
              // and the next would silently join the new value. Value correctness wins: they go.
              let after = lines[i];
              while (
                out[out.length - 1]?.endsWith(eol) &&
                after &&
                original.slice(after.start, after.end).trim() === ""
              ) {
                i++;
                after = lines[i];
              }
              continue;
            }
            const line = lines[i];
            if (line) out.push(original.slice(line.start, line.end));
            i++;
          }
          for (const k of Object.keys(next)) if (!seen.has(k)) out.push(emitEntry(k, next[k], eol));
          if (out.length > 0) return closeBlock(out.join(eol), next, eol);
        }
      }
    } catch {}
  }
  return closeBlock(blockText(YAML.stringify(next, { lineWidth: 0 }), eol), next, eol);
}

/** The lines of one group. A group that OWNS its lines keeps them verbatim while its key is
 *  unchanged (inline comment and all), re-emits the key in their place when it changed, and drops
 *  them when it was removed. A group that owns nothing — a root flow mapping, braces and all — is
 *  rebuilt key by key, comments re-emitted as full lines around it, so a changed flow root comes
 *  back in BLOCK style. An unchanged key splices from its node range only when it HAS one. */
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
      : emitEntry(s.key, next[s.key], eol);
  if (!group.ownsLines)
    return [...(group.before ?? []), ...kept.map(rebuild), ...(group.after ?? [])];
  const only = kept[0];
  if (!only) return [];
  if (!isDeepStrictEqual(prevObj[only.key], next[only.key]))
    return [emitEntry(only.key, next[only.key], eol)];
  return lines.slice(group.firstLine, group.lastLine + 1).map((l) => text.slice(l.start, l.end));
}

/** Fallback delimiter EOL for a caller with no captured `frontmatterEol` (a brand-new note),
 *  inferred from whatever CRLF signal the raw block or body carries. `serializeNote` prefers the
 *  authoritative `options.frontmatterEol` whenever given. */
function delimiterEol(original: string | null | undefined, body: string): string {
  return original?.includes("\r\n") || body.includes("\r\n") ? "\r\n" : "\n";
}

/** One source line's [start, end), the end EXCLUDING its terminator (on CRLF, the "\r" too). */
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

/** Lines rewritten as a unit: one block-style key, or every key of a shared line. `before`/`after`
 *  are comments those lines carry outside every key — on or inside a flow mapping's braces — moved
 *  to full lines around the rebuild: appended to an emitted line, one joins a multi-line value. */
interface LineGroup {
  firstLine: number;
  lastLine: number;
  keys: KeySpan[];
  ownsLines: boolean;
  before?: string[];
  after?: string[];
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

/** The [firstLine, lastLine] a node's [start, end) byte range occupies. A multi-line node commonly
 *  ends just PAST its own trailing break, on the next line — which belongs to what follows. */
function lineSpanOf(lines: SourceLine[], start: number, end: number): [number, number] {
  const firstLine = lineIndexAt(lines, start);
  const endLine = lineIndexAt(lines, end);
  const endAt = lines[endLine];
  if (endAt && end === endAt.start && endLine > firstLine) return [firstLine, endLine - 1];
  return [firstLine, endLine];
}

/** THE-1043: map every key to the lines its node covers, and to whether it OWNS them. Ownership
 *  means block style — nothing but whitespace before the key on its first line, nothing but
 *  whitespace or a comment (which belongs to the key) after its value on the last. Keys whose line
 *  ranges touch form one group, the unit the emitter keeps, rebuilds or drops, in `map.items`
 *  order. Null = a non-scalar key: the caller falls back to a plain stringify. A FLOW root is the
 *  exception — no key owns a line and the braces belong to none, so the collection is ONE group,
 *  rebuilt with the comments on and inside the braces as `before`/`after`. */
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
  const keys = groups.flatMap((g) => g.keys);
  // Everything the braces hold that belongs to no key — the comment after "{", a comment line
  // between entries — plus whatever follows "}" on its line. Whitespace there is not content and
  // is dropped; a comment is kept.
  const before: string[] = [];
  let at = range[0];
  for (const k of keys) {
    if (k.start > at) before.push(...commentLines(text.slice(at, k.start)));
    at = Math.max(at, k.end);
  }
  if (range[1] > at) before.push(...commentLines(text.slice(at, range[1])));
  const after = last ? commentLines(text.slice(Math.min(range[1], last.end), last.end)) : [];
  return [{ firstLine, lastLine, keys, ownsLines: false, before, after }];
}

/** The comments in a stretch of source no node covers, one per line, `#` onwards. */
function commentLines(chunk: string): string[] {
  const out: string[] = [];
  for (const line of chunk.split("\n")) {
    const at = line.indexOf("#");
    if (at !== -1) out.push(line.slice(at).trimEnd());
  }
  return out;
}

/** THE-1040 F1/C2/C4/O1: what (if anything) of a raw block survives once the caller's mapping is
 *  empty. Comments are content, never discarded just because every real key is gone — but an
 *  INLINE comment belongs to its key, so only a full-line comment or a blank line survives. A block
 *  with no real mapping comes back byte-for-byte; null drops the delimiters. */
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
  // An empty/absent mapping covers `null` (no block, or one a caller emptied) and `{}` (zero
  // keys, e.g. parseNote's result for a comment-only block). Both route through
  // survivingComments, which tells a truly-empty block from one still carrying comments.
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    const kept = survivingComments(originalFrontmatter, eol);
    if (kept !== null) return `---${eol}${kept}${eol}${close}${body}`;
    return body;
  }
  return `---${eol}${emitFrontmatter(frontmatter, originalFrontmatter, eol)}${eol}${close}${body}`;
}
