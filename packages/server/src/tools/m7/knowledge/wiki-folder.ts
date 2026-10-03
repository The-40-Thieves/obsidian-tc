// Where a wiki page may live. The wiki folder is the one place commit_wiki_page creates pages
// without a confirmation, so "inside it" must mean the same DIRECTORY, and a string cannot say that:
// `Café` in two Unicode forms is one directory on APFS and two on Linux, `Wiki` and `wiki` are one
// directory on a case-insensitive volume and two on a case-sensitive one (and Darwin volumes can be
// either). So the check asks the filesystem: the folder's device + inode must be that of a directory
// above the page, on the path the caller wrote AND on the real path it resolves to (a symlink inside
// the wiki folder must not carry a page out of it). No string normalisation is involved, so none can
// make two distinct directories equal. A folder that does not exist yet has no identity: then only
// the exact configured spelling is in it, and any other spelling is refused (fail closed). A vault
// with no wiki folder has no place a page may go: nothing is ever "in the wiki" by default.
import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { CASE_INSENSITIVE_FS } from "../../../acl";
import { resolveVaultPath, resolveVaultPathChecked } from "../../../vault/paths";

/** A path in the form two names for one file share: NFC, and lower-cased when `ci`. */
export const foldPath = (path: string, ci: boolean = CASE_INSENSITIVE_FS): string => {
  const nfc = path.normalize("NFC");
  return ci ? nfc.toLowerCase() : nfc;
};

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

/** Whether `path` is one of the wiki folder's generated pages: they are never wiki pages, so
 *  duplicate detection, lint and the link scans leave them out. Same fold as `pathInFolder`. */
export function isGeneratedWikiPath(
  path: string,
  wikiFolder: string | undefined,
  ci: boolean = CASE_INSENSITIVE_FS,
): boolean {
  if (!wikiFolder) return false;
  const p = foldPath(path, ci);
  const dir = foldPath(wikiFolder, ci);
  return p === `${dir}/${WIKI_INDEX_FILE}` || p === `${dir}/${WIKI_LOG_FILE}`;
}

/** `dev:ino` of the directory at `abs` (symlinks followed); null when it is not an existing directory
 *  or the filesystem reports no inode (a fake inode 0 proves nothing). */
function dirIdentity(abs: string): string | null {
  try {
    const st = statSync(abs, { bigint: true });
    return st.isDirectory() && st.ino !== 0n ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}

/** Whether the folder (identified by `folderId`) is one of the directories above `rel`. */
function folderAbove(root: string, folderId: string, rel: string): boolean {
  const segs = rel.split("/").slice(0, -1);
  for (let n = segs.length; n > 0; n--)
    if (dirIdentity(join(root, ...segs.slice(0, n))) === folderId) return true;
  return false;
}

/**
 * Refuse a page path that is not inside the configured wiki folder, as the filesystem resolves it,
 * on the path as written and after symlinks. `pageRel` is already normalised (`..` and absolute
 * paths were refused there).
 */
export function assertWikiPagePath(
  root: string,
  wikiFolder: string | undefined,
  pageRel: string,
): void {
  if (!wikiFolder)
    throw err.invalidInput(
      "commit_wiki_page needs this vault's wiki folder: set vaults[].wiki.folder in the config",
      { reason: "no_wiki_folder", path: pageRel },
    );
  const outside = (): never => {
    throw err.invalidInput(`a wiki page must be inside the wiki folder (${wikiFolder}/)`, {
      reason: "outside_wiki_folder",
      path: pageRel,
      wiki_folder: wikiFolder,
    });
  };
  if (!insideFolder(root, wikiFolder, pageRel)) outside();
}

/**
 * Whether `rel` (normalised) is inside `folder` as the filesystem resolves it, on the path as
 * written AND on the real path it leads to: a symlink under the folder must not carry a path out of
 * it, and one leading in does not make a path outside it the folder's. `folder` that does not exist
 * yet has no identity: only the exact configured spelling is in it (fail closed).
 */
export function insideFolder(root: string, folder: string, rel: string): boolean {
  const realRel = resolveVaultPathChecked(root, rel).aclRel;
  const folderId = dirIdentity(resolveVaultPath(root, folder));
  if (folderId === null) {
    const prefix = `${folder}/`;
    return rel.startsWith(prefix) && realRel.startsWith(prefix);
  }
  return folderAbove(root, folderId, rel) && folderAbove(root, folderId, realRel);
}

/** Whether a vault-relative path is inside the vault's raw-sources folder, by name. Raw notes are
 *  inputs, never wiki pages: the page checks (is there already a page on this topic, which notes
 *  should link to a new page) leave them out. No raw folder: nothing is raw. */
export function rawPathFilter(rawFolder: string | undefined): (rel: string) => boolean {
  return rawFolder === undefined ? () => false : (rel) => pathInFolder(rel, rawFolder);
}

/** Where a vault's configured raw folder really is: `canonical` is the in-vault directory it leads to
 *  when that is not the configured spelling (a symlinked folder or ancestor), null when it is the
 *  folder itself or does not exist yet. Not ok: the folder leaves the vault, is the vault root, or
 *  its identity cannot be established (a dangling symlink, not a directory); the caller then locks
 *  nothing extra and refuses to ingest from it. */
export type RawFolderPlacement =
  | { ok: true; canonical: string | null }
  | { ok: false; reason: string };

export function rawFolderPlacement(root: string, rawFolder: string): RawFolderPlacement {
  let aclRel: string;
  try {
    aclRel = resolveVaultPathChecked(root, rawFolder).aclRel;
  } catch {
    return { ok: false, reason: "it leaves the vault or cannot be resolved" };
  }
  if (aclRel === "") return { ok: false, reason: "it resolves to the vault root" };
  const abs = resolveVaultPath(root, rawFolder);
  let exists = true;
  try {
    lstatSync(abs);
  } catch {
    exists = false;
  }
  if (exists && dirIdentity(abs) === null)
    return { ok: false, reason: "its directory identity cannot be established" };
  return { ok: true, canonical: aclRel === rawFolder ? null : aclRel };
}

/** Whether two configured folders are one directory, or one holds the other, as the filesystem
 *  resolves them (a symlinked folder is the same directory as its target; spelling cannot say that). A
 *  folder that does not exist has no identity and overlaps nothing here: the lexical check covers it. */
export function foldersShareDirectory(root: string, a: string, b: string): boolean {
  const idA = dirIdentity(resolveVaultPath(root, a));
  const idB = dirIdentity(resolveVaultPath(root, b));
  if (idA === null || idB === null) return false;
  const holds = (folder: string, id: string): boolean => {
    let real: string | null = null;
    try {
      real = resolveVaultPathChecked(root, folder).aclRel;
    } catch {
      real = null;
    }
    return [folder, real].some(
      (rel) => rel !== null && rel !== "" && folderAbove(root, id, `${rel}/x`),
    );
  };
  return holds(a, idB) || holds(b, idA);
}
