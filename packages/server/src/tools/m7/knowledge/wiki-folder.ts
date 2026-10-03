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
import { statSync } from "node:fs";
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
  const realPage = resolveVaultPathChecked(root, pageRel).aclRel;
  const folderId = dirIdentity(resolveVaultPath(root, wikiFolder));
  if (folderId === null) {
    // Nothing to compare against: only the configured spelling, byte for byte, is in the folder.
    const prefix = `${wikiFolder}/`;
    if (!pageRel.startsWith(prefix) || !realPage.startsWith(prefix)) outside();
    return;
  }
  if (!folderAbove(root, folderId, pageRel) || !folderAbove(root, folderId, realPage)) outside();
}
