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

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export type Frontmatter = Record<string, unknown>;

export interface ParsedNote {
  frontmatter: Frontmatter | null;
  body: string;
  hasFrontmatter: boolean;
  /** Verbatim YAML text from inside the block (null when absent). Pass it back to
   *  serializeNote so keys the caller did not change keep their exact source. */
  rawFrontmatter: string | null;
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
  if (!m) return { frontmatter: null, body: raw, hasFrontmatter: false, rawFrontmatter: null };
  let fm: Frontmatter;
  try {
    const parsed = YAML.parse(m[1] ?? "") as unknown;
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
    rawFrontmatter: m[1] ?? "",
  };
}

/** Serialize a single key/value entry (used for added/changed keys). */
function emitEntry(key: string, value: unknown): string {
  return YAML.stringify({ [key]: value }, { lineWidth: 0 }).replace(/\n+$/, "");
}

/**
 * Build the frontmatter YAML body. With original (the verbatim source), unchanged
 * keys are spliced back from the source byte-for-byte and only added/changed keys are
 * re-serialized; without it, plain-stringify the object.
 */
function emitFrontmatter(next: Frontmatter, original?: string | null): string {
  if (original && original.length > 0) {
    try {
      const doc = YAML.parseDocument(original);
      const map = doc.contents;
      const prev = doc.toJS();
      if (isMap(map) && prev && typeof prev === "object" && !Array.isArray(prev)) {
        const prevObj = prev as Frontmatter;
        if (isDeepStrictEqual(prevObj, next)) return original.replace(/[\r\n]+$/, "");
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
            entries.push(original.slice(kr[0], vr[1]).replace(/\n+$/, ""));
          } else {
            entries.push(emitEntry(k, next[k]));
          }
        }
        for (const k of Object.keys(next)) if (!seen.has(k)) entries.push(emitEntry(k, next[k]));
        if (entries.length > 0) return entries.join("\n");
      }
    } catch {}
  }
  return YAML.stringify(next, { lineWidth: 0 }).replace(/\n+$/, "");
}

/** Delimiter line ending: follows the source note (CRLF when the raw frontmatter block
 *  or the body carries \r\n) so a CRLF note keeps CRLF delimiters; LF for a note with
 *  no source (a newly-built note has nothing to follow). The raw block alone is not
 *  always enough — a single-line block (e.g. one comment, one key) has no INTERNAL
 *  line break for the FRONTMATTER regex to keep (it strips the boundary line breaks
 *  next to the delimiters), so body is the fallback signal for that shape of note. */
function delimiterEol(original: string | null | undefined, body: string): string {
  return original?.includes("\r\n") || body.includes("\r\n") ? "\r\n" : "\n";
}

/** Re-emit a note from frontmatter + body. Pass originalFrontmatter to preserve
 *  untouched keys exactly. */
export function serializeNote(
  frontmatter: Frontmatter | null,
  body: string,
  originalFrontmatter?: string | null,
): string {
  // `null` is a caller's explicit "drop the block" (update_frontmatter/remove_tag pass it
  // deliberately once the last real key is gone) — distinct from `{}`, an object that
  // genuinely has zero keys, e.g. parseNote's result for a comment-only block. Only `{}`
  // falls through to the THE-1040 preserve-verbatim check below.
  if (!frontmatter) return body;
  const eol = delimiterEol(originalFrontmatter, body);
  if (Object.keys(frontmatter).length === 0) {
    // THE-1040: a block containing only YAML comments parses to an empty mapping,
    // same as a genuinely blank one ("---\n\n---") — only the raw source text tells
    // them apart. Preserve it verbatim; a whitespace-only block still drops (ruling c).
    if (originalFrontmatter && originalFrontmatter.trim().length > 0) {
      const block = originalFrontmatter.replace(/[\r\n]+$/, "");
      return `---${eol}${block}${eol}---${eol}${body}`;
    }
    return body;
  }
  return `---${eol}${emitFrontmatter(frontmatter, originalFrontmatter)}${eol}---${eol}${body}`;
}
