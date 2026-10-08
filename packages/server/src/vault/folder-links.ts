// The native safe-open follows NO symlink in any path component, so a configured vault folder that is
// a symlink (`wiki -> pages`, `raw -> sources`) cannot be opened by its configured name. This module
// is the one place that bridges the two, and it holds the only state involved: the PIN table.
//
// A pin is placed once, when the vault registry is built (vault/registry.ts): each configured
// `wiki.folder` / `wiki.rawFolder` that is reached through a symlink is resolved to its real directory,
// which must sit strictly inside the vault root (otherwise no pin: the native open keeps refusing,
// fail closed). Every registry build REPLACES the table wholesale, so a folder dropped from the config
// loses its pin. After that, nothing here reads a symlink again:
//  - the ACL (resolveVaultPathChecked) refuses a path under a pinned folder whose live realpath no
//    longer equals the pinned one, so a retargeted symlink is never authorized;
//  - the native sinks (notes-io) open the pinned directory by `pinnedFolderPath`, a pure function of
//    the table and the path, then walk it with O_NOFOLLOW (a symlink under it is still refused).
// Whenever both pass they name the same file, whatever the symlink does in between.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** A configured folder reached through a symlink, placed when the registry was built. */
export interface FolderPin {
  /** The vault root it was configured under, as the registry holds it. */
  root: string;
  /** The folder by its configured name: `<root>/wiki`. */
  alias: string;
  /** The real directory it was at registry build: `<root>/pages`, strictly inside `root`. `null`:
   *  the root did not exist at build, so the first ACL resolution through the folder places it
   *  (`placeDeferredPin`), once; until then nothing is translated. */
  target: string | null;
}

/** Most specific root first, then the longest alias: the first match is the one that applies. */
let pins: FolderPin[] = [];

/** Install the registry's pins, replacing every earlier one. */
export function replaceFolderPins(next: ReadonlyArray<FolderPin>): void {
  pins = [...next].sort((a, b) => b.root.length - a.root.length || b.alias.length - a.alias.length);
}

const under = (abs: string, alias: string): boolean => abs === alias || abs.startsWith(alias + sep);

/** The real directory of `alias` when it is a symlinked directory strictly inside `root`. */
function pinTarget(root: string, alias: string): string | null {
  try {
    const target = realpathSync(alias);
    const rel = relative(root, target);
    const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    return target !== alias && inside && statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

/** Resolve `folders` (vault-relative, `/`-separated) of the vault at `root` to their pins, now. A
 *  folder that is not a symlink, is missing, is not a directory, or does not lead strictly inside the
 *  vault gets none, as does every folder of a root that exists but is not its own real path. */
export function pinFolders(root: string, folders: ReadonlyArray<string>): FolderPin[] {
  const aliases = folders.map((folder) => join(root, ...folder.split("/")));
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return aliases.map((alias) => ({ root, alias, target: null }));
  }
  if (realRoot !== root) return [];
  return aliases.flatMap((alias) => {
    const target = pinTarget(root, alias);
    return target === null ? [] : [{ root, alias, target }];
  });
}

/** Place the deferred pin `abs` runs through, if any: once, from the folder as it is now. */
export function placeDeferredPin(abs: string): void {
  const pin = pins.find((p) => under(abs, p.alias));
  if (pin === undefined || pin.target !== null) return;
  let real: string | null = null;
  try {
    real = realpathSync(pin.root);
  } catch {
    return; // the root is still missing: stay deferred
  }
  pin.target = real === pin.root ? pinTarget(pin.root, pin.alias) : null;
  if (pin.target === null) pins = pins.filter((p) => p !== pin);
}

/** `abs` with a pinned folder's configured name swapped for its pinned directory; `abs` itself when
 *  it is under no pin or the pin is still deferred. Reads nothing from the filesystem. */
export function pinnedFolderPath(abs: string): string {
  const pin = pins.find((p) => under(abs, p.alias));
  return pin?.target ? pin.target + abs.slice(pin.alias.length) : abs;
}
