// Tag extraction + hierarchical matching. Obsidian tags come from two places:
// the `tags`/`tag` frontmatter keys (list or whitespace/comma string) and inline
// `#hashtags` in the body. Inline scanning is fenced- and inline-code-aware so
// `#define` in a code sample is never counted, and pure-number tokens (`#123`)
// are skipped per Obsidian's rules. Tags are hierarchical: `#project/sub` is a
// child of `#project`, and a query for `project` matches both.
import type { Frontmatter } from "./frontmatter";
import { parseNote } from "./frontmatter";

const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /`[^`]*`/g;
// A tag is `#` (at start-of-line or after whitespace) then a run of tag chars
// beginning with a non-slash. Group 1 is the boundary char, group 2 the tag.
const TAG = /(^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;

export interface NoteTags {
  frontmatter: string[];
  inline: string[];
  all: string[];
}

/** Normalize a user/string tag: strip a leading `#`, trim, drop trailing slashes. */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").trim().replace(/\/+$/, "");
}

export function isValidTag(tag: string): boolean {
  const t = normalizeTag(tag);
  return /^[A-Za-z0-9_][A-Za-z0-9_/-]*$/.test(t) && /[A-Za-z_-]/.test(t);
}

/** Inline `#hashtags` in body order, de-duplicated, code-aware. */
export function extractInlineTags(body: string): string[] {
  const out = new Set<string>();
  const lines = body.split(/\r?\n/);
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const ranges = [...line.matchAll(INLINE_CODE)].map(
      (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as [number, number],
    );
    for (const m of line.matchAll(TAG)) {
      const hashIdx = (m.index ?? 0) + (m[1] ?? "").length;
      if (ranges.some(([a, b]) => hashIdx >= a && hashIdx < b)) continue;
      const tag = normalizeTag(m[2] ?? "");
      if (tag && /[A-Za-z_-]/.test(tag)) out.add(tag);
    }
  }
  return [...out];
}

/** Tags declared in the `tags`/`tag` frontmatter keys (list or string form). */
export function frontmatterTags(fm: Frontmatter | null): string[] {
  if (!fm) return [];
  const out = new Set<string>();
  const collect = (val: unknown): void => {
    if (typeof val === "string")
      for (const piece of val.split(/[,\s]+/)) {
        const t = normalizeTag(piece);
        if (t) out.add(t);
      }
    else if (Array.isArray(val))
      for (const e of val)
        if (typeof e === "string") {
          const t = normalizeTag(e);
          if (t) out.add(t);
        }
  };
  collect(fm.tags);
  collect(fm.tag);
  return [...out];
}

/** Combined frontmatter + inline tags for a raw note. */
export function noteTags(raw: string): NoteTags {
  const parsed = parseNote(raw);
  const frontmatter = frontmatterTags(parsed.frontmatter);
  const inline = extractInlineTags(parsed.body);
  const all = [...new Set([...frontmatter, ...inline])].sort();
  return { frontmatter, inline, all };
}

/** Hierarchical match: query equals the tag, or is one of its ancestors. */
export function tagMatches(query: string, tag: string): boolean {
  const q = normalizeTag(query).toLowerCase();
  const t = normalizeTag(tag).toLowerCase();
  return t === q || t.startsWith(`${q}/`);
}
