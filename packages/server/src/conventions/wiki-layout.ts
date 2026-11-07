// The wiki/raw folder LAYOUT contract: the names a vault's wiki folder goes by, the two
// server-generated pages in it, the SCHEMA.md convention file with its parse caps, and the
// raw-sources folder filter. Pure spelling-level facts — no filesystem access. Folder IDENTITY
// (what a configured folder resolves to through symlinks) lives in vault/wiki-folders.ts.
//
// Lifted out of tools/m7/knowledge/: conventions/ and vault/registration need these too, and a
// contract imported from one consumer's tool module cannot be generalised
// (no-conventions-imports-high / no-low-layer-imports-high).
import { CASE_INSENSITIVE_FS, foldPath } from "../acl";

/** Whether `path` is strictly inside `folder` (both vault-relative, normalised, no trailing slash). */
export function pathInFolder(
  path: string,
  folder: string,
  ci: boolean = CASE_INSENSITIVE_FS,
): boolean {
  return foldPath(path, ci).startsWith(`${foldPath(folder, ci)}/`);
}

/** The two server-generated pages of a wiki folder (see wiki-generated.ts). */
export const WIKI_INDEX_FILE = "index.md";
export const WIKI_LOG_FILE = "log.md";

/** SCHEMA.md: the wiki folder's own statement of what a page is (see wiki-schema.ts). */
export const WIKI_SCHEMA_FILE = "SCHEMA.md";

/** The frontmatter property that names a page's type. */
export const WIKI_TYPE_KEY = "type";

/** SCHEMA.md is read synchronously and expanded into every draft response, so it is bounded: a file
 *  over the byte cap is not read at all, and a section over a count or length cap is cut with a
 *  warning (the rest of the file still counts). Real schemas are a few KiB. */
export const SCHEMA_LIMITS = {
  fileBytes: 64 * 1024,
  types: 100,
  fieldsPerType: 100,
  properties: 500,
  valuesPerProperty: 200,
  textChars: 200,
  descriptionChars: 500,
} as const;

/** The names a vault's wiki folder goes by: the configured spelling, then the in-vault directory it
 *  really is when that differs (a symlinked folder or ancestor; `""` is the vault root). The index
 *  and the scans see the real spelling, so "is this a generated page?" takes this, not the configured
 *  name alone. A folder that cannot be placed has only its configured name. */
export type WikiFolders = string | readonly string[] | undefined;

/** Whether `path` is one of the wiki folder's generated pages, under any of its names: they are never
 *  wiki pages, so duplicate detection, lint, the link scans and the judge leave them out. Same fold
 *  as `pathInFolder`. */
export function isGeneratedWikiPath(
  path: string,
  wikiFolder: WikiFolders,
  ci: boolean = CASE_INSENSITIVE_FS,
): boolean {
  if (wikiFolder === undefined) return false;
  const p = foldPath(path, ci);
  const names = typeof wikiFolder === "string" ? [wikiFolder] : wikiFolder;
  return names.some((name) => {
    if (name === "" && typeof wikiFolder === "string") return false;
    const dir = foldPath(name, ci);
    const prefix = dir === "" ? "" : `${dir}/`;
    return p === `${prefix}${WIKI_INDEX_FILE}` || p === `${prefix}${WIKI_LOG_FILE}`;
  });
}

/** The names a vault's raw folder goes by: the configured spelling, then the in-vault directory it
 *  really is when that differs (a symlinked folder or ancestor). One list per vault, built once, that
 *  every "is this a raw note?" decision shares, so a note is as raw under `sources/` as under `raw/`. */
export type RawFolders = string | readonly string[] | undefined;

/** Whether a vault-relative path is inside the vault's raw-sources folder, under any of its names.
 *  Raw notes are inputs, never wiki pages: the page checks (is there already a page on this topic,
 *  which notes should link to a new page) and the judge leave them out. No raw folder: nothing is raw. */
export function rawPathFilter(rawFolders: RawFolders): (rel: string) => boolean {
  const names =
    rawFolders === undefined ? [] : typeof rawFolders === "string" ? [rawFolders] : rawFolders;
  return names.length === 0 ? () => false : (rel) => names.some((f) => pathInFolder(rel, f));
}
