// Where a wiki page may live. The wiki folder is the one place commit_wiki_page creates pages
// without a confirmation, so "inside it" is judged on the path the caller wrote AND on the real
// path it resolves to (a symlinked folder inside the wiki folder must not carry a page out of it),
// folded for case where the filesystem is case-insensitive. A vault with no wiki folder has no
// place a page may go: nothing is ever "in the wiki" by default.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { CASE_INSENSITIVE_FS } from "../../../acl";
import { resolveVaultPathChecked } from "../../../vault/paths";

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

/**
 * Refuse a page path that is not inside the configured wiki folder, lexically or after symlinks.
 * `pageRel` is already normalised (`..` and absolute paths were refused there).
 */
export function assertWikiPagePath(
  root: string,
  wikiFolder: string | undefined,
  pageRel: string,
  ci: boolean = CASE_INSENSITIVE_FS,
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
  if (!pathInFolder(pageRel, wikiFolder, ci)) outside();
  const realPage = resolveVaultPathChecked(root, pageRel).aclRel;
  const realFolder = resolveVaultPathChecked(root, wikiFolder).aclRel;
  if (!pathInFolder(realPage, realFolder, ci)) outside();
}
