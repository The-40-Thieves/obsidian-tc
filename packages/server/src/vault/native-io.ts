// The native symlink-safe vault I/O (THE-272) as notes-io sees it: the optional compiled module, and
// the one rule that decides what a path through a PINNED folder (vault/folder-links.ts) may do.
//
// A configured symlinked folder (`wiki -> pages`) is only reachable through a pin, and a pin is only
// as good as the open that verifies it: the native walk opens the pinned directory with O_NOFOLLOW
// and fstats it. Node has no openat, so every pure-JS path (no addon, Windows,
// OBSIDIAN_TC_FORCE_JS_FALLBACK, a .node that predates the primitive) would have to follow the live
// alias, and a retarget between the check and the open would hit another in-vault file. Those paths
// therefore REFUSE a path that runs through a pinned folder (`refuseJsThroughPin`); folders that are
// not symlinks are untouched.
import { createRequire } from "node:module";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type PinnedDir, pinnedOpenPath } from "./folder-links";

export interface NativeVaultIo {
  safeReadNote(abs: string, pinned?: PinnedDir): Buffer;
  safeWriteNoteAtomic(abs: string, data: Buffer): void;
  /** No-replace write / rename / unlink. Optional: an older .node predates them and the JS path is
   *  used (an extra argument to safeWriteNoteAtomic would be silently ignored by such a binary). */
  safeWriteNoteExclusive?(abs: string, data: Buffer): void;
  safeRenameNoReplace?(
    fromAbs: string,
    toAbs: string,
    fromPinned?: PinnedDir,
    toPinned?: PinnedDir,
  ): void;
  /** Unlink on the verified parent; false: the leaf was already absent. */
  safeUnlink?(abs: string, pinned?: PinnedDir): boolean;
  /** The binary verifies a PinnedDir (`SAFE_IO_PINNED_DIR`). An older one would ignore the pin, so
   *  without it no path is translated to a pinned directory (the walk refuses the symlink). */
  pinnedDirs: boolean;
}

const NATIVE_PKG = ["@the-40-thieves", "obsidian-tc-native"].join("/");

function loadNativeIo(): NativeVaultIo | null {
  if (process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK === "1") return null;
  try {
    const mod = createRequire(import.meta.url)(NATIVE_PKG) as Partial<NativeVaultIo> & {
      nativeLoaded?: boolean;
      SAFE_IO_PINNED_DIR?: boolean;
    };
    if (
      mod.nativeLoaded === true &&
      typeof mod.safeReadNote === "function" &&
      typeof mod.safeWriteNoteAtomic === "function"
    ) {
      return {
        safeReadNote: mod.safeReadNote,
        safeWriteNoteAtomic: mod.safeWriteNoteAtomic,
        pinnedDirs: mod.SAFE_IO_PINNED_DIR === true,
        ...(typeof mod.safeWriteNoteExclusive === "function"
          ? { safeWriteNoteExclusive: mod.safeWriteNoteExclusive }
          : {}),
        ...(typeof mod.safeRenameNoReplace === "function"
          ? { safeRenameNoReplace: mod.safeRenameNoReplace }
          : {}),
        ...(typeof mod.safeUnlink === "function" ? { safeUnlink: mod.safeUnlink } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const nativeIo = loadNativeIo();

/** True when note reads/writes route through the native symlink-safe open (THE-272). */
export const nativeVaultIo: boolean = nativeIo !== null;

/** `abs` as the native open takes it: under a placed folder pin, the pinned directory plus the
 *  identity the native walk verifies; otherwise `abs` itself. */
export function nativeOpen(abs: string): { path: string; pinned?: PinnedDir } {
  return nativeIo?.pinnedDirs ? pinnedOpenPath(abs) : { path: abs };
}

/** Called by every pure-JS path before it touches `abs`: a path through a pinned folder is refused,
 *  because only the native walk can open it without a window for the symlink to move. */
export function refuseJsThroughPin(abs: string): void {
  if (pinnedOpenPath(abs).pinned === undefined) return;
  throw err.aclDenied(
    "configured symlinked folders require the native module: this path runs through one, and without it (Windows, OBSIDIAN_TC_FORCE_JS_FALLBACK, or an addon-less install) it cannot be opened safely",
    { path: abs },
  );
}
