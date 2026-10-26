// A note the safe open refuses (acl_denied) is skipped by a whole-vault walk, not an abort of the
// whole call. The walk lists a note under its symlink-resolved identity; the read goes through the
// safe open, which refuses an unconfigured symlinked folder (`wiki -> pages`) and a hard link to a
// file outside the vault. Only acl_denied is caught here: every other error (ENOENT for a note
// deleted mid-pass, a non-regular file) propagates unchanged. Under the native module an ordinary I/O
// failure on a regular file also surfaces as acl_denied, so it is skipped and counted; only the JS
// fallback propagates it.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { errorMessage } from "../util/errors";
import { readNote, readNoteBounded } from "./notes-io";
import { resolveVaultPath } from "./paths";

/** The note's raw text, or the refusal message when the safe open refused the read. */
export function readNoteOrRefusal(
  root: string,
  rel: string,
): { raw: string } | { refused: string } {
  return refusalOr(() => ({ raw: readNote(resolveVaultPath(root, rel)).raw }));
}

/** As readNoteOrRefusal, but `raw` is null for a note over `maxBytes` (never read past the cap). */
export function readNoteBoundedOrRefusal(
  root: string,
  rel: string,
  maxBytes: number,
): { raw: string | null } | { refused: string } {
  return refusalOr(() => readNoteBounded(resolveVaultPath(root, rel), maxBytes));
}

function refusalOr<T>(read: () => T): T | { refused: string } {
  try {
    return read();
  } catch (e) {
    if (e instanceof ObsidianTcError && e.code === "acl_denied")
      return { refused: errorMessage(e) };
    throw e;
  }
}
