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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { contentHash } from "./paths";

// O_NOFOLLOW is POSIX-only; on Windows Node it is undefined. Fall back to 0 (no-op) —
// the st_nlink inode check is the cross-platform guard; O_NOFOLLOW additionally refuses a
// symlink planted at a write temp path on the platforms that support it.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// THE-272: prefer the native, symlink-safe, TOCTOU-free open when the compiled module is loaded. It
// opens following no symlink in ANY path component, closing the intermediate-directory symlink-swap
// race that the pure-JS fd path (which re-resolves the lexical path at open) cannot. When the native
// module is absent — an unsupported platform, a `.mcpb` without the addon, the pure-JS-fallback CI
// job, or `OBSIDIAN_TC_FORCE_JS_FALLBACK=1` — we keep the JS path, which retains the documented
// residual (the hard-link + final-component-symlink guards still apply there).
interface NativeVaultIo {
  safeReadNote(abs: string): Buffer;
  safeWriteNoteAtomic(abs: string, data: Buffer): void;
}
const NATIVE_PKG = ["@the-40-thieves", "obsidian-tc-native"].join("/");
function loadNativeIo(): NativeVaultIo | null {
  if (process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK === "1") return null;
  try {
    const mod = createRequire(import.meta.url)(NATIVE_PKG) as Partial<NativeVaultIo> & {
      nativeLoaded?: boolean;
    };
    if (
      mod.nativeLoaded === true &&
      typeof mod.safeReadNote === "function" &&
      typeof mod.safeWriteNoteAtomic === "function"
    ) {
      return { safeReadNote: mod.safeReadNote, safeWriteNoteAtomic: mod.safeWriteNoteAtomic };
    }
    return null;
  } catch {
    return null;
  }
}
const nativeIo = loadNativeIo();

/** True when note reads/writes route through the native symlink-safe open (THE-272). */
export const nativeVaultIo: boolean = nativeIo !== null;

/** Reclassify a native safe-open rejection at `abs`: a genuinely-missing path keeps ENOENT
 *  semantics (matching the JS path's openSync), while a path that resolves — through a symlink or a
 *  hard link — but was refused is surfaced as acl_denied (fail-closed) rather than a raw napi error. */
function mapNativeReadError(e: unknown, abs: string): never {
  if (!existsSync(abs)) {
    const enoent = new Error(`ENOENT: no such file, open '${abs}'`) as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    throw enoent;
  }
  throw err.aclDenied(`safe open refused the path: ${(e as Error).message}`, { path: abs });
}

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
  if (nativeIo) {
    try {
      const raw = nativeIo.safeReadNote(abs).toString("utf8");
      return { raw, hash: contentHash(raw) };
    } catch (e) {
      mapNativeReadError(e, abs);
    }
  }
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
  if (nativeIo) {
    try {
      return nativeIo.safeReadNote(abs);
    } catch (e) {
      mapNativeReadError(e, abs);
    }
  }
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
  if (nativeIo) {
    try {
      nativeIo.safeWriteNoteAtomic(abs, Buffer.from(content, "utf8"));
      return;
    } catch (e) {
      // A safe-write rejection (a symlinked path component, or the target itself a symlink) is
      // acl_denied. A genuinely-missing parent (createDirs=false on a not-yet-created dir) keeps
      // ENOENT semantics, matching the JS temp-open below.
      if (!existsSync(dirname(abs))) {
        const enoent = new Error(
          `ENOENT: no such file or directory, open '${abs}'`,
        ) as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        throw enoent;
      }
      throw err.aclDenied(`safe write refused the path: ${(e as Error).message}`, { path: abs });
    }
  }
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
