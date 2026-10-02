// A vault's raw-sources folder (`wiki.rawFolder`): the immutable inputs the LLM wiki is built from.
// The default sits BESIDE the wiki folder (`wiki` -> `raw`, `notes/wiki` -> `notes/raw`), not under
// it: everything under the wiki folder is a wiki page that lint_wiki checks and commit_wiki_page may
// create, and a source is neither. The two must never overlap, in either direction, so a page can
// never be written into the immutable folder and the immutable rule can never cover a wiki page.
import { normalizeVaultPath } from "./paths";

/** `folder` exactly as written when it is a canonical in-vault folder path; anything else throws
 *  rather than being reinterpreted (a value that quietly became the whole vault would turn every
 *  note into a page, or every note into an immutable source). */
export function canonicalFolderOf(vaultId: string, key: string, folder: string): string {
  let canonical: string | undefined;
  try {
    canonical = folder === "" ? undefined : normalizeVaultPath(folder);
  } catch {
    canonical = undefined;
  }
  if (canonical === undefined || canonical === "" || canonical !== folder || /[:\0]/.test(folder))
    throw new Error(
      `vault "${vaultId}": ${key} must be a folder path inside the vault (for example "wiki"), got ${JSON.stringify(folder)}`,
    );
  return folder;
}

const fold = (p: string): string => p.normalize("NFC").toLowerCase();

/** Whether two folders are the same or one holds the other, folded for case on every platform (two
 *  spellings that are one directory on some volume must not both be configured). */
export function foldersOverlap(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** The raw folder a wiki folder gets when none is configured: `raw` beside it. Undefined when that
 *  would overlap the wiki folder itself (a wiki folder named `raw`, or inside one): then the vault
 *  has no raw folder until `wiki.rawFolder` names one. */
export function defaultRawFolder(wikiFolder: string): string | undefined {
  const slash = wikiFolder.lastIndexOf("/");
  const candidate = slash < 0 ? "raw" : `${wikiFolder.slice(0, slash)}/raw`;
  return foldersOverlap(candidate, wikiFolder) ? undefined : candidate;
}

/** The effective raw folder for a vault's `wiki` block. Undefined: no wiki, or no raw folder. */
export function rawFolderOf(
  vaultId: string,
  wiki: { folder: string; rawFolder?: string | undefined } | undefined,
): string | undefined {
  if (!wiki) return undefined;
  if (wiki.rawFolder === undefined) return defaultRawFolder(wiki.folder);
  const raw = canonicalFolderOf(vaultId, "wiki.rawFolder", wiki.rawFolder);
  if (foldersOverlap(raw, wiki.folder))
    throw new Error(
      `vault "${vaultId}": wiki.rawFolder (${JSON.stringify(raw)}) must not be, contain or sit inside wiki.folder (${JSON.stringify(wiki.folder)})`,
    );
  return raw;
}

/** The globs that make `rawFolder` immutable: the folder itself and everything under it. */
export const immutableGlobsFor = (rawFolder: string): string[] => [rawFolder, `${rawFolder}/**`];
