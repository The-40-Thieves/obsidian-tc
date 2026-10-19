// A note the safe open refuses (acl_denied) is skipped by indexVault, not an abort of the whole pass.
// The walk lists a note under its symlink-resolved identity; the read goes through the safe open,
// which refuses an unconfigured symlinked folder (`wiki -> pages`) and a hard-linked file that
// gained its second link after the walk's stat. Only that refusal is caught here: every other error
// (ENOENT for a note deleted mid-pass, I/O, a non-regular file) propagates unchanged.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { errorMessage } from "../../util/errors";
import { readNote } from "../../vault/notes-io";
import { resolveVaultPath } from "../../vault/paths";
import { ACL_PATH_UNRESOLVED } from "../../vault/stored-acl-path";
import type { IndexStats } from "./types";

/** The note's raw text, or the refusal message when the safe open refused the read. */
export function readIndexableNote(
  root: string,
  rel: string,
): { raw: string } | { refused: string } {
  try {
    return { raw: readNote(resolveVaultPath(root, rel)).raw };
  } catch (e) {
    if (e instanceof ObsidianTcError && e.code === "acl_denied")
      return { refused: errorMessage(e) };
    throw e;
  }
}

/** Records one refused read: counted and named by the pass, and its identity becomes UNRESOLVED. The name
 *  stays in walkedSet, so the sweep does not treat the note as deleted, and it fails closed. */
export function recordReadRefusal(
  stats: IndexStats,
  walkedSet: Map<string, string>,
  rel: string,
  error: string,
): void {
  stats.notes_read_refused += 1;
  stats.read_refusals.push({ path: rel, error });
  walkedSet.set(rel, ACL_PATH_UNRESOLVED);
}

/** The refused notes as the identity map syncAclPaths writes: a stored row under the name fails closed. */
export function refusedIdentities(
  failures: Array<{ path: string; error: string }>,
): ReadonlyMap<string, string> {
  return new Map(failures.map((f) => [f.path, ACL_PATH_UNRESOLVED]));
}
