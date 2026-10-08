// The native safe-open follows NO symlink in any path component, so a configured vault folder that is
// a symlink (`wiki -> pages`, `raw -> sources`) cannot be opened by its configured name: the JS-side
// resolution accepts it (it lands inside the vault) and the native open then refuses the component.
// This module is the one place that bridges the two. The vault registry records the folders an
// operator configured (`wiki.folder`, `wiki.rawFolder`); `nativeSafePath` swaps ONLY such a folder's
// lexical prefix for the directory it really is, resolved now and required to sit inside the vault.
// The native open of that real path still refuses a symlink in every component, so a symlink planted
// anywhere else, or under the real directory, is refused as before. Nothing else is translated.
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** Vault root (as the registry holds it) -> its configured folders, vault-relative with `sep`. */
const configured = new Map<string, Set<string>>();

/** Record the operator-configured folders of the vault rooted at `root` (idempotent). */
export function registerConfiguredFolders(root: string, folders: ReadonlyArray<string>): void {
  const set = configured.get(root) ?? new Set<string>();
  for (const folder of folders) {
    const rel = folder.split("/").filter(Boolean).join(sep);
    if (rel !== "") set.add(rel);
  }
  if (set.size > 0) configured.set(root, set);
}

/** Is `real` the directory `root` or something inside it? */
function insideOrEqual(root: string, real: string): boolean {
  const rel = relative(root, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `abs`, or when it runs through a configured folder that is a symlink, the same file by the
 *  folder's real directory. Unchanged for every other path, for a folder that is not a symlink, and
 *  whenever the real place cannot be established inside the vault (the native open then refuses). */
export function nativeSafePath(abs: string): string {
  if (configured.size === 0) return abs;
  for (const [root, folders] of configured) {
    if (!abs.startsWith(root + sep)) continue;
    const rest = abs.slice(root.length + 1);
    for (const folder of folders) {
      if (rest !== folder && !rest.startsWith(folder + sep)) continue;
      try {
        // A root that is itself reached through a symlink is the registry's business to refuse.
        const realRoot = realpathSync.native(root);
        if (realRoot !== root) return abs;
        const realFolder = realpathSync.native(join(root, folder));
        if (!insideOrEqual(realRoot, realFolder)) return abs;
        return join(realFolder, rest.slice(folder.length));
      } catch {
        return abs;
      }
    }
  }
  return abs;
}
