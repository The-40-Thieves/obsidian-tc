// The `dev:ino` identity of a vault file or directory: two paths name one file exactly when their
// identities are equal, whatever their spelling (case, symlink, Unicode form). Used where a string
// comparison is not enough, e.g. to tell a rename onto its own note from one onto a different note.
import { statSync } from "node:fs";
import { resolveVaultPath, resolveVaultPathChecked } from "./paths";

/** `dev:ino` of the inode at `abs` (symlinks followed), or null when it does not exist, is not a
 *  directory where one is required, or the filesystem reports no inode (a fake inode 0 proves
 *  nothing). */
export function inodeIdentity(abs: string, requireDirectory = true): string | null {
  try {
    const st = statSync(abs, { bigint: true });
    return (!requireDirectory || st.isDirectory()) && st.ino !== 0n ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}

/** `dev:ino` of an existing path after symlinks, or null when no stable identity exists. */
export function filesystemIdentity(root: string, rel: string): string | null {
  try {
    const checked = resolveVaultPathChecked(root, rel);
    return inodeIdentity(resolveVaultPath(root, checked.aclRel), false);
  } catch {
    return null;
  }
}
