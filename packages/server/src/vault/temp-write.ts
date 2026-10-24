// Temp-file primitives for the note writers: an O_EXCL, no-follow temp file on a random name, so a
// planted symlink cannot hijack the write (H-4). Split out of notes-io.ts to keep it under the
// line ceiling; notes-io re-uses them, and this module imports nothing from notes-io.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";

export const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Write every byte of `data` (writeSync may write fewer than asked). */
export function writeAll(fd: number, data: Buffer): void {
  for (let off = 0; off < data.length; ) off += writeSync(fd, data, off, data.length - off, null);
}

/** O_EXCL + O_NOFOLLOW on a RANDOM temp name (H-4); unlinked if the write fails. */
export function writeTempFile(abs: string, data: Buffer, sync: boolean): string {
  const tmp = `${abs}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeAll(fd, data);
      if (sync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    removeTemp(tmp);
    throw e;
  }
  return tmp;
}

export function removeTemp(tmp: string): void {
  try {
    unlinkSync(tmp);
  } catch {
    // best-effort cleanup: nothing more to do if the removal fails
  }
}
