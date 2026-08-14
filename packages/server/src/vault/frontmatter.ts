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

/** Split a note into its frontmatter object (if any) and verbatim body. */
export function parseNote(raw: string): ParsedNote {
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
    // the caller's entire diagnostic. NOTE path-threading deferred (see THE-823 writeup): parseNote
    // has ~19 non-test call sites and none pass a note path in today, so naming the FILE is out of
    // scope here — only the parser's own line/column detail is restored.
    const detail = e instanceof YAMLParseError ? e.message.split("\n")[0] : undefined;
    throw err.invalidInput(
      detail ? `frontmatter is not valid YAML: ${detail}` : "frontmatter is not valid YAML",
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
        if (isDeepStrictEqual(prevObj, next)) return original.replace(/\n+$/, "");
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

/** Re-emit a note from frontmatter + body. Pass originalFrontmatter to preserve
 *  untouched keys exactly. */
export function serializeNote(
  frontmatter: Frontmatter | null,
  body: string,
  originalFrontmatter?: string | null,
): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
  return `---\n${emitFrontmatter(frontmatter, originalFrontmatter)}\n---\n${body}`;
}
