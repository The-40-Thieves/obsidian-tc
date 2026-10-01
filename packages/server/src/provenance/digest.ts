// Digests of the vault files a write names, for write provenance.
//
// Containment is the write path's own guard (`resolveVaultPathChecked`: lexical traversal plus a
// realpath check that refuses an in-vault symlink or symlinked ancestor pointing outside the
// vault), so a digest can never be used to probe a file the tools themselves could not touch.
// Anything it refuses is `unhashable`, never read.
//
// The check and the open are two syscalls, and `O_NOFOLLOW` only guards the LEAF: a directory
// swapped for a symlink between them would make `open` follow it. So after opening, the path is
// resolved and checked again and the opened fd must be the very file it names (same dev + ino);
// otherwise the answer is `unhashable` and nothing was hashed.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolveVaultPathChecked } from "../vault/paths";
import { DIGEST_ABSENT, DIGEST_UNHASHABLE, type Digest } from "./types";

/** Largest file hashed; bigger is `unhashable` so one huge attachment cannot stall dispatch. */
export const MAX_HASH_BYTES = 256 * 1024 * 1024;

/** Test seam: runs between the containment check and the open (where a race would land). */
export interface DigestSeam {
  afterCheck?: (abs: string) => void | Promise<void>;
}

export async function digestUnder(
  root: string | undefined,
  path: string,
  seam?: DigestSeam,
): Promise<Digest> {
  if (root === undefined) return DIGEST_UNHASHABLE;
  let abs: string;
  try {
    abs = resolveVaultPathChecked(root, path).abs;
  } catch {
    return DIGEST_UNHASHABLE;
  }
  await seam?.afterCheck?.(abs);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_HASH_BYTES) return DIGEST_UNHASHABLE;
    const named = await stat(resolveVaultPathChecked(root, path).abs);
    if (named.dev !== st.dev || named.ino !== st.ino) return DIGEST_UNHASHABLE;
    const h = createHash("sha256");
    for await (const chunk of fh.createReadStream({ autoClose: false })) h.update(chunk as Buffer);
    return h.digest("hex");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? DIGEST_ABSENT : DIGEST_UNHASHABLE;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
