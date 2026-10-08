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
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, parse, relative, sep } from "node:path";
import {
  err,
  ObsidianTcError,
  type VaultMemoryDefenseConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import { existsNoFollow } from "../auth/key-files";
import { enforceMemoryDefenseOnNoteWrite } from "../experiential/memory-defense";
import { redactSecrets } from "../experiential/redact";
import type { MetricsRecorder } from "../metrics/registry";
import { pinnedFolderPath } from "./folder-links";
import { assertCreatableName, contentHash } from "./paths";

// O_NOFOLLOW is POSIX-only (undefined on Windows Node): 0 is a no-op there, and the st_nlink inode
// check is the cross-platform guard.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// THE-272: prefer the native, symlink-safe, TOCTOU-free open when the compiled module is loaded: it
// follows no symlink in ANY path component. Without it (unsupported platform, no addon, or
// `OBSIDIAN_TC_FORCE_JS_FALLBACK=1`) the JS path keeps its documented residual.
interface NativeVaultIo {
  safeReadNote(abs: string): Buffer;
  safeWriteNoteAtomic(abs: string, data: Buffer): void;
  /** No-replace write / rename. Optional: an older .node predates them and the JS link+unlink path
   *  is used (an extra argument to safeWriteNoteAtomic would be silently ignored by such a binary). */
  safeWriteNoteExclusive?(abs: string, data: Buffer): void;
  safeRenameNoReplace?(fromAbs: string, toAbs: string): void;
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
      return {
        safeReadNote: mod.safeReadNote,
        safeWriteNoteAtomic: mod.safeWriteNoteAtomic,
        ...(typeof mod.safeWriteNoteExclusive === "function"
          ? { safeWriteNoteExclusive: mod.safeWriteNoteExclusive }
          : {}),
        ...(typeof mod.safeRenameNoReplace === "function"
          ? { safeRenameNoReplace: mod.safeRenameNoReplace }
          : {}),
      };
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

/** Fail closed on inode aliasing: a hard link (nlink > 1) could alias a file outside the folder ACL
 *  into an allowed path, which realpath cannot see (C-1b). fstat is on the OPEN fd: no TOCTOU. */
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
      const raw = nativeIo.safeReadNote(pinnedFolderPath(abs)).toString("utf8");
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

/** readNote with a byte ceiling: `raw` is null over `maxBytes`; the JS path reads at most one byte past it. */
export function readNoteBounded(abs: string, maxBytes: number): { raw: string | null } {
  if (nativeIo) {
    try {
      const buf = nativeIo.safeReadNote(pinnedFolderPath(abs));
      return { raw: buf.length > maxBytes ? null : buf.toString("utf8") };
    } catch (e) {
      mapNativeReadError(e, abs);
    }
  }
  const fd = openSync(abs, constants.O_RDONLY);
  try {
    assertRegularSingleLink(fd, abs);
    const buf = Buffer.allocUnsafe(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    return { raw: n > maxBytes ? null : buf.toString("utf8", 0, n) };
  } finally {
    closeSync(fd);
  }
}

/** Binary read (attachments) with the same inode-aliasing guard as readNote. */
export function readFileChecked(abs: string): Buffer {
  if (nativeIo) {
    try {
      return nativeIo.safeReadNote(pinnedFolderPath(abs));
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

/** True for a native no-replace refusal (`exists: …`) — mapped to note_exists. */
function isNativeExists(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("exists:");
}

function noteExistsConcurrently(): ObsidianTcError {
  return err.noteExists("target already exists; nothing was replaced");
}

/**
 * Create `dir` and any missing ancestors WITHOUT following a symlink: each component is lstat'ed
 * from the root down, a missing one is made with a non-recursive mkdir, and a symlinked (or
 * non-directory) component is refused (`mkdirSync(recursive)` followed a planted symlink out of the
 * vault). Shared by every vault writer and the trash move; `create: false` only verifies existing
 * components. Same rule as the native writer; a NEW Windows-hostile component is refused too.
 * Pure-JS residual: lstat and the later open are not one atomic step; the native path re-checks.
 */
export function ensureDirNoFollow(dir: string, create = true): void {
  const { root } = parse(dir);
  let cur = root;
  for (const seg of dir.slice(root.length).split(sep)) {
    if (seg === "") continue;
    cur = join(cur, seg);
    let st: Stats | null;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw e;
      st = null;
    }
    if (st === null) {
      assertCreatableName(seg, seg);
      try {
        mkdirSync(cur);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      st = lstatSync(cur);
    }
    if (st.isSymbolicLink())
      throw err.aclDenied("refusing a symlinked path component", { path: seg });
    if (!st.isDirectory())
      throw err.pathInvalid("a path component is not a directory", { path: seg });
  }
}

/** Commit `tmp` to `abs` ONLY IF `abs` does not exist: `link(tmp, abs)` fails EEXIST, then `tmp` is
 *  dropped. Without hard links the name is reserved with an O_EXCL placeholder and renamed over. */
function commitNoReplace(tmp: string, abs: string): void {
  try {
    linkSync(tmp, abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      unlinkSync(tmp);
      throw noteExistsConcurrently();
    }
    if (code !== "EPERM" && code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") {
      unlinkSync(tmp);
      throw e;
    }
    try {
      closeSync(
        openSync(
          abs,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
          0o600,
        ),
      );
    } catch (e2) {
      unlinkSync(tmp);
      if ((e2 as NodeJS.ErrnoException).code === "EEXIST") throw noteExistsConcurrently();
      throw e2;
    }
    try {
      renameSync(tmp, abs);
    } catch (e3) {
      removeTemp(abs);
      removeTemp(tmp);
      throw e3;
    }
    return;
  }
  // The target now exists under its final name; a temp name we cannot drop is only litter.
  try {
    unlinkSync(tmp);
  } catch {
    // best-effort cleanup: nothing more to do if the removal fails
  }
}

/** Write every byte of `data` (writeSync may write fewer than asked). */
function writeAll(fd: number, data: Buffer): void {
  for (let off = 0; off < data.length; ) off += writeSync(fd, data, off, data.length - off, null);
}

export interface WriteFileOpts {
  /** No-replace commit: an existing target throws note_exists. */
  exclusive?: boolean;
  /** The leaf existed and replaceDestination just trashed it: re-creating it mints no NEW name, so
   *  the hostile-name refusal is skipped. Set only by replaceDestination. */
  replacesExisting?: boolean;
}

/** Atomic binary write: the note writer's temp + rename and symlink-safe open, for raw bytes.
 *  `exclusive` makes the final step a no-replace commit: an existing target is never replaced and
 *  throws note_exists — the race-free form of an `overwrite: false` check-then-write. */
export function writeFileAtomic(
  abs: string,
  data: Buffer,
  createDirs = true,
  opts: WriteFileOpts = {},
): void {
  // Backstop for writers that skipped enforcePathAcl("write"): creating a Windows-hostile leaf name
  // is refused here too (an existing file stays updatable in place).
  if (!opts.replacesExisting && !existsNoFollow(abs))
    assertCreatableName(basename(abs), basename(abs));
  if (createDirs) ensureDirNoFollow(dirname(abs));
  const nativeWrite = opts.exclusive
    ? nativeIo?.safeWriteNoteExclusive
    : nativeIo?.safeWriteNoteAtomic;
  if (nativeIo && nativeWrite) {
    try {
      nativeWrite(abs, data);
      return;
    } catch (e) {
      if (isNativeExists(e)) throw noteExistsConcurrently();
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
  const tmp = writeTempFile(abs, data, false);
  try {
    if (opts.exclusive) commitNoReplace(tmp, abs);
    else renameSync(tmp, abs);
  } catch (e) {
    removeTemp(tmp);
    throw e;
  }
}

/** O_EXCL + O_NOFOLLOW on a RANDOM temp name (H-4); unlinked if the write fails. */
function writeTempFile(abs: string, data: Buffer, sync: boolean): string {
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

function removeTemp(tmp: string): void {
  try {
    unlinkSync(tmp);
  } catch {
    // best-effort cleanup: nothing more to do if the removal fails
  }
}

export interface StagedWrite {
  commit(): void;
  discard(): void;
}

export function stageNoteWrite(
  abs: string,
  content: string,
  createDirs: boolean,
  opts: WriteFileOpts = {},
): StagedWrite {
  const data = Buffer.from(content, "utf8");
  if (nativeIo) return { commit: () => writeFileAtomic(abs, data, createDirs, opts), discard() {} };
  if (!opts.replacesExisting && !existsNoFollow(abs))
    assertCreatableName(basename(abs), basename(abs));
  if (createDirs) ensureDirNoFollow(dirname(abs));
  const tmp = writeTempFile(abs, data, true);
  let settled = false;
  return {
    commit() {
      if (settled) throw new Error("staged write already settled");
      settled = true;
      try {
        if (opts.exclusive) commitNoReplace(tmp, abs);
        else renameSync(tmp, abs);
      } catch (e) {
        removeTemp(tmp);
        throw e;
      }
    },
    discard() {
      if (settled) return;
      settled = true;
      removeTemp(tmp);
    },
  };
}

/**
 * Move `fromAbs` onto `toAbs` WITHOUT replacing an existing target or following a symlink in either
 * path (native: parents opened no-follow; JS: lstat'ed components, then link + unlink). An occupied
 * target throws note_exists. The primitive behind trashNote and its rollback.
 */
export function moveNoReplace(fromAbs: string, toAbs: string): void {
  if (nativeIo?.safeRenameNoReplace) {
    try {
      nativeIo.safeRenameNoReplace(pinnedFolderPath(fromAbs), pinnedFolderPath(toAbs));
      return;
    } catch (e) {
      if (isNativeExists(e)) throw noteExistsConcurrently();
      if (!existsSync(fromAbs)) {
        const enoent = new Error(
          `ENOENT: no such file or directory, rename '${fromAbs}'`,
        ) as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        throw enoent;
      }
      throw err.aclDenied(`safe rename refused the path: ${(e as Error).message}`, {
        path: toAbs,
      });
    }
  }
  ensureDirNoFollow(dirname(fromAbs), false);
  ensureDirNoFollow(dirname(toAbs), false);
  try {
    linkSync(fromAbs, toAbs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw noteExistsConcurrently();
    // No hard links here (FAT/exFAT, some network mounts). A rename would REPLACE a destination
    // created after any check, so copy the bytes with an exclusive create instead, then drop the
    // source: still no-replace, never check-then-rename.
    if (code !== "EPERM" && code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP")
      throw e;
    copyExclusiveThenUnlink(fromAbs, toAbs);
    return;
  }
  try {
    unlinkSync(fromAbs);
  } catch (e) {
    // The old name is held open (AV scanner, Windows): undo the new link, so a failed move never
    // leaves the file under both names, then surface the error as renameSync would have.
    try {
      unlinkSync(toAbs);
    } catch {
      // best-effort cleanup: nothing more to do if the removal fails
    }
    throw e;
  }
}

/** {@link moveNoReplace} without hard links: O_EXCL-create the destination from the source's bytes
 *  (EEXIST is note_exists), then unlink the source; a failure removes the new destination again. */
function copyExclusiveThenUnlink(fromAbs: string, toAbs: string): void {
  const src = openSync(fromAbs, constants.O_RDONLY | O_NOFOLLOW);
  let data: Buffer;
  let mode: number;
  try {
    const st = assertRegularSingleLink(src, fromAbs);
    mode = st.mode & 0o777;
    data = readFileSync(src);
  } finally {
    closeSync(src);
  }
  let dst: number;
  try {
    dst = openSync(
      toAbs,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      mode,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw noteExistsConcurrently();
    throw e;
  }
  try {
    try {
      writeAll(dst, data);
    } finally {
      closeSync(dst);
    }
    unlinkSync(fromAbs);
  } catch (e) {
    try {
      unlinkSync(toAbs);
    } catch {
      // best-effort cleanup: nothing more to do if the removal fails
    }
    throw e;
  }
}

export function writeNoteAtomic(
  abs: string,
  content: string,
  createDirs = true,
  opts: WriteFileOpts = {},
): void {
  writeFileAtomic(abs, Buffer.from(content, "utf8"), createDirs, opts);
}

/**
 * The memory-defense-guarded entry point for a note-content writer with a vault's memoryDefense
 * config in hand (instead of hand-composing `enforceMemoryDefenseOnNoteWrite` + `writeNoteAtomic`).
 * Refuses a secret-shaped `path` and scans/redacts `content` BEFORE persisting; `off` mode is a
 * passthrough. Returns the persisted (possibly redacted) content.
 */
export function writeNoteAtomicGuarded(
  abs: string,
  path: string,
  content: string,
  createDirs: boolean,
  config: VaultMemoryDefenseConfig | undefined,
  opts: { metrics?: MetricsRecorder; exclusive?: boolean } = {},
): { content: string; redactions: number } {
  const scan = enforceMemoryDefenseOnNoteWrite(config, path, content, opts);
  writeNoteAtomic(abs, scan.content, createDirs, { exclusive: opts.exclusive ?? false });
  return scan;
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

/** Stem and extension of a vault path: trashNote inserts ` (n)` between them on a collision. */
function splitTrashName(relPath: string): { stem: string; ext: string } {
  const dot = relPath.lastIndexOf(".");
  const slash = relPath.lastIndexOf("/");
  return dot > slash
    ? { stem: relPath.slice(0, dot), ext: relPath.slice(dot) }
    : { stem: relPath, ext: "" };
}

/**
 * Soft-delete: move a note into the vault's `.trash/` mirror (Obsidian trash). Returns the
 * vault-relative trash path. A name collision gets a ` (n)` suffix, chosen by the no-replace move
 * itself refusing an occupied name (no check-then-rename window). A symlinked `.trash` (or any
 * symlinked component) is refused, never followed.
 */
export function trashNote(root: string, relPath: string): string {
  const { stem, ext } = splitTrashName(relPath);
  const src = join(root, relPath);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? relPath : `${stem} (${i})${ext}`;
    const dest = join(root, ".trash", candidate);
    ensureDirNoFollow(dirname(dest));
    try {
      moveNoReplace(src, dest);
      return `.trash/${candidate}`;
    } catch (e) {
      if (!(e instanceof ObsidianTcError && e.code === "note_exists") || i >= 10_000) throw e;
    }
  }
}

/** True when `trashedRel` is a name {@link trashNote} could have given `relPath`. */
function isTrashNameOf(trashedRel: string, relPath: string): boolean {
  if (trashedRel === `.trash/${relPath}`) return true;
  const { stem, ext } = splitTrashName(relPath);
  const head = `.trash/${stem} (`;
  const tail = `)${ext}`;
  return (
    trashedRel.length > head.length + tail.length &&
    trashedRel.startsWith(head) &&
    trashedRel.endsWith(tail) &&
    /^\d+$/.test(trashedRel.slice(head.length, trashedRel.length - tail.length))
  );
}

/** Put a file trashed by {@link trashNote} back at `destAbs` (no-follow, no-replace: a re-created
 *  path throws note_exists). `destAbs` must be the path it was trashed from: the move performs no
 *  name check, so this is what stops a restore minting a new (hostile) name. */
export function restoreTrashed(root: string, trashedRel: string, destAbs: string): void {
  const rel = relative(root, destAbs).split(sep).join("/");
  if (rel === "" || rel.startsWith("..") || !isTrashNameOf(trashedRel, rel))
    throw err.pathInvalid("a trashed file is restored only to the path it was trashed from", {
      path: redactSecrets(rel).text,
    });
  moveNoReplace(join(root, trashedRel), destAbs);
}

/** Options {@link replaceDestination} hands the write step (pass to the writer). */
export interface ReplaceWriteOpts {
  exclusive: true;
  replacesExisting: boolean;
}

/**
 * The one step behind every overwrite (move_note, copy_note, move_attachment, bulk_move_notes,
 * write_attachment): trash the existing destination, create the new one exclusively, and on ANY
 * failure put the destination back where it was. The caller runs EVERY refusal (ACL, memoryDefense
 * scan, prev_hash, confirmation) BEFORE calling; the destructive part starts here.
 *
 * `markEffectCommitted` fires once the change is not undone: after the write landed, or when the
 * write failed AND the rollback could not restore. A rolled-back failure changed nothing, so the
 * retry is a clean re-run, not an indeterminate_outcome.
 *
 * An existing Windows-hostile name (legal on Linux: `a:b.md`) is replaced in place: it already
 * existed, so re-creating it mints nothing new.
 */
export function replaceDestination<T = void>(args: {
  root: string;
  toRel: string;
  toAbs: string;
  replacing: boolean;
  write: (opts: ReplaceWriteOpts) => T;
  markEffectCommitted?: () => void;
}): { trashedTo: string | null; value: T } {
  const trashedTo = args.replacing ? trashNote(args.root, args.toRel) : null;
  let value: T;
  try {
    value = args.write({ exclusive: true, replacesExisting: trashedTo !== null });
  } catch (e) {
    if (trashedTo !== null) {
      try {
        restoreTrashed(args.root, trashedTo, args.toAbs);
      } catch {
        args.markEffectCommitted?.();
      }
    }
    throw e;
  }
  args.markEffectCommitted?.();
  return { trashedTo, value };
}

export function hardDelete(abs: string): void {
  rmSync(abs, { force: true });
}
