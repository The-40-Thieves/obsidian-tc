// A note the safe open refuses (acl_denied) is skipped by a whole-vault walk, not an abort of the
// whole call. The walk lists a note under its symlink-resolved identity; the read goes through the
// safe open, which refuses an unconfigured symlinked folder (`wiki -> pages`) and a hard link to a
// file outside the vault. Only that refusal is caught here: every other error (ENOENT for a note
// deleted mid-pass, I/O, a non-regular file) propagates unchanged.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { errorMessage } from "../util/errors";
import { readNote } from "./notes-io";
import { resolveVaultPath } from "./paths";

/** The note's raw text, or the refusal message when the safe open refused the read. */
export function readNoteOrRefusal(
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
