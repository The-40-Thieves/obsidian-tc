// Filesystem note IO. Reads and writes go through fd-based primitives that reject
// inode aliasing (hard links): a regular file with nlink > 1 is a second directory
// entry for the same inode, so a folder-ACL check on the alias path would otherwise
// serve a file living outside the allowed folder (C-1b — realpath cannot see a hard
// link). Writes are atomic (O_EXCL temp + rename) so a crash never leaves a half-written
// note and Obsidian's watcher sees a single replace, and the temp open is exclusive +
// no-follow on a randomized name so a planted symlink cannot hijack the write (H-4).
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { contentHash } from "./paths";

// O_NOFOLLOW is POSIX-only; on Windows Node it is undefined. Fall back to 0 (no-op) —
// the st_nlink inode check is the cross-platform guard; O_NOFOLLOW additionally refuses a
// symlink planted at a write temp path on the platforms that support it.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface NoteStat {
  size: number;
  mtime: string;
  ctime: string;
}

export function noteExists(abs: string): { exists: boolean; type?: "file" | "folder" } {
  if (!existsSync(abs)) return { exists: false };
  try {
    return { exists: true, type: statSync(abs).isDirectory() ? "folder" : "file" };
  } catch {
    return { exists: false };
  }
}

/**
 * Fail closed on inode aliasing. A regular file with nlink > 1 is a hard link — a second
 * name for the same inode — so a caller could alias a file outside its folder ACL into an
 * allowed path and have realpath (which cannot dereference a hard link) approve it (C-1b).
 * The fstat is on the OPEN fd, so this is check-and-use on the same object, not a TOCTOU.
 */
function assertRegularSingleLink(fd: number, abs: string): Stats {
  const st = fstatSync(fd);
  if (!st.isFile()) throw err.pathInvalid("not a regular file", { path: abs });
  if (st.nlink > 1)
    throw err.aclDenied("refusing to read a hard-linked file (inode aliasing)", { path: abs });
  return st;
}

export function readNote(abs: string): { raw: string; hash: string } {
  const fd = openSync(abs, constants.O_RDONLY);
  try {
    assertRegularSingleLink(fd, abs);
    const raw = readFileSync(fd, "utf8");
    return { raw, hash: contentHash(raw) };
  } finally {
    closeSync(fd);
  }
}

/** Binary read (attachments) with the same inode-aliasing guard as readNote. */
export function readFileChecked(abs: string): Buffer {
  const fd = openSync(abs, constants.O_RDONLY);
  try {
    assertRegularSingleLink(fd, abs);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeNoteAtomic(abs: string, content: string, createDirs = true): void {
  if (createDirs) mkdirSync(dirname(abs), { recursive: true });
  // Exclusive-create (O_EXCL) + no-follow on a RANDOM temp name: a symlink planted at a
  // predictable temp path can no longer be opened (O_EXCL fails if it exists; O_NOFOLLOW
  // refuses a symlink), so an in-ACL note write can never be redirected into an arbitrary
  // file (H-4). O_EXCL is honored cross-platform; O_NOFOLLOW is a POSIX-only add.
  const tmp = `${abs}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, content, null, "utf8");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, abs);
}

export function statNote(abs: string): NoteStat | null {
  try {
    const s = statSync(abs);
    return {
      size: s.size,
      mtime: new Date(s.mtimeMs).toISOString(),
      ctime: new Date(s.ctimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Soft-delete: move a note into the vault's `.trash/` mirror (Obsidian trash).
 * Returns the vault-relative trash path. A name collision (deleting two notes
 * with the same relative path) is disambiguated with a ` (n)` suffix rather than
 * clobbering the earlier trashed copy — renameSync over an existing file throws
 * EPERM on Windows, so we never rename onto an occupied destination.
 */
export function trashNote(root: string, relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  const slash = relPath.lastIndexOf("/");
  const stem = dot > slash ? relPath.slice(0, dot) : relPath;
  const ext = dot > slash ? relPath.slice(dot) : "";
  let candidate = relPath;
  for (let i = 1; existsSync(join(root, ".trash", candidate)); i++)
    candidate = `${stem} (${i})${ext}`;
  const dest = join(root, ".trash", candidate);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(join(root, relPath), dest);
  return `.trash/${candidate}`;
}

export function hardDelete(abs: string): void {
  rmSync(abs, { force: true });
}
