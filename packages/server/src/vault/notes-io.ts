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
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, parse, sep } from "node:path";
import {
  err,
  ObsidianTcError,
  type VaultMemoryDefenseConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import { existsNoFollow } from "../auth/key-files";
import { enforceMemoryDefenseOnNoteWrite } from "../experiential/memory-defense";
import type { MetricsRecorder } from "../metrics/registry";
import { assertCreatableName, contentHash } from "./paths";

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

/** True for a native no-replace refusal (`exists: …`) — mapped to note_exists. */
function isNativeExists(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("exists:");
}

function noteExistsConcurrently(): ObsidianTcError {
  return err.noteExists("target already exists; nothing was replaced");
}

/**
 * Create `dir` and any missing ancestors WITHOUT following a symlink: each component is lstat'ed
 * from the filesystem root down, a missing one is made with a non-recursive mkdir and re-lstat'ed,
 * and a symlinked (or non-directory) component is refused. `mkdirSync(recursive)` followed a planted
 * symlink out of the vault, and ran BEFORE the no-follow open. Shared by every vault writer and the
 * trash move; `create: false` only verifies existing components (the source side of a rename).
 * Same rule as the native writer (a symlink in ANY component, ancestors of the root included, is
 * refused: the registry canonicalizes the root). A NEW Windows-hostile component is refused too.
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

/**
 * Commit `tmp` to `abs` ONLY IF `abs` does not exist, atomically: `link(tmp, abs)` fails EEXIST if
 * the name is taken, then `tmp` is dropped. Without hard links (FAT/exFAT, some network mounts) the
 * name is reserved with an O_EXCL placeholder we own and renamed over: still exclusive.
 */
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
    renameSync(tmp, abs);
    return;
  }
  // The target now exists under its final name; a temp name we cannot drop is only litter.
  try {
    unlinkSync(tmp);
  } catch {}
}

/** Atomic binary write: the note writer's temp + rename and symlink-safe open, for raw bytes.
 *  `exclusive` makes the final step a no-replace commit: an existing target is never replaced and
 *  throws note_exists — the race-free form of an `overwrite: false` check-then-write. */
export function writeFileAtomic(
  abs: string,
  data: Buffer,
  createDirs = true,
  opts: { exclusive?: boolean } = {},
): void {
  // Backstop for writers that skipped enforcePathAcl("write"): creating a Windows-hostile leaf name
  // is refused here too (an existing file stays updatable in place).
  if (!existsNoFollow(abs)) assertCreatableName(basename(abs), basename(abs));
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
    // writeSync may write fewer bytes than asked; loop so a large attachment is never truncated.
    for (let off = 0; off < data.length; ) off += writeSync(fd, data, off, data.length - off, null);
  } finally {
    closeSync(fd);
  }
  if (opts.exclusive) commitNoReplace(tmp, abs);
  else renameSync(tmp, abs);
}

/**
 * Move `fromAbs` onto `toAbs` WITHOUT replacing an existing target or following a symlink in either
 * path (native: parents opened no-follow; JS: components lstat'ed, then link + unlink). An occupied
 * target throws note_exists. The one primitive behind trashNote and its rollback: a plain
 * renameSync followed a planted `.trash` symlink out of the vault in both directions.
 */
export function moveNoReplace(fromAbs: string, toAbs: string): void {
  if (nativeIo?.safeRenameNoReplace) {
    try {
      nativeIo.safeRenameNoReplace(fromAbs, toAbs);
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
    // No hard links here: best effort (check, then rename; racy unlike the above).
    if (code !== "EPERM" && code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP")
      throw e;
    if (existsNoFollow(toAbs)) throw noteExistsConcurrently();
    renameSync(fromAbs, toAbs);
    return;
  }
  try {
    unlinkSync(fromAbs);
  } catch (e) {
    // The old name is held open (AV scanner, Windows): undo the new link, so a failed move never
    // leaves the file under both names, then surface the error as renameSync would have.
    try {
      unlinkSync(toAbs);
    } catch {}
    throw e;
  }
}

export function writeNoteAtomic(
  abs: string,
  content: string,
  createDirs = true,
  opts: { exclusive?: boolean } = {},
): void {
  writeFileAtomic(abs, Buffer.from(content, "utf8"), createDirs, opts);
}

/**
 * the one memory-defense-guarded entry point every note-content writer that has a
 * vault's memoryDefense config in hand should call, instead of hand-composing
 * `enforceMemoryDefenseOnNoteWrite` + `writeNoteAtomic` at each call site (the PR #1015 pattern,
 * which a new writer could otherwise reorder or drop under review). Refuses a secret-shaped
 * `path` and scans/redacts `content` BEFORE persisting; `off` mode is a pure passthrough — see
 * `enforceMemoryDefenseOnNoteWrite`'s own doc for the exact policy. Returns the persisted
 * (possibly redacted) content so the caller can index/hash what actually landed on disk.
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

/** One rewritten note body headed for disk, as `writeNotesAllOrNothingGuarded` takes it. */
export interface NoteRewriteEntry {
  abs: string;
  /** Vault-relative path — the same `path` `enforceMemoryDefenseOnNoteWrite` scans/refuses on. */
  path: string;
  content: string;
}

/**
 * Scan-then-persist a BATCH of note-content rewrites as one all-or-nothing unit: every entry's
 * final body is scanned via `enforceMemoryDefenseOnNoteWrite` in pass 1, BEFORE any of them is
 * written in pass 2 — so a `block`-mode refusal on entry N throws before entries before it have
 * been written, never a half-applied rewrite (a caller retrying after refusal would otherwise be
 * unable to tell which of N notes it left repointed and which still point at the stale target).
 *
 * The shared pattern behind a backlink/reference rewrite that touches multiple notes for one
 * logical operation — `rewriteAttachmentReferences` (formats/attachments.ts), move_note's
 * backlink rewrite, and bulk_move_notes' `rewriteForMoves` all route through this rather than each
 * hand-rolling the same two-pass loop, which is what let move_note's and rewriteForMoves' own
 * copies drift from the correct all-or-nothing shape in the first place.
 *
 * Every entry writes with `createDirs: false` — a backlink rewrite always targets a note that
 * already exists on disk, never a new path. Metrics/redaction counts are recorded ONCE, during
 * the scan pass: the bytes pass 2 writes are exactly what pass 1 already scanned (deterministic),
 * and pass 1 only completes when every entry is proven not block-worthy, so counting there already
 * reflects what actually lands on disk — pass 2 does not re-scan.
 *
 * "All-or-nothing" here means SCAN-atomic, not WRITE-atomic: no writes on a scan refusal
 * (pass 1 completing is the only thing that lets pass 2 start), but pass 2 itself is a
 * plain sequential loop of independent `writeNoteAtomic` calls with no rollback. An I/O failure
 * mid-batch (ENOSPC, a permission error, a process kill) after some entries have already been
 * written by pass 2 still leaves those earlier notes rewritten and the rest untouched — this
 * helper guards against a memoryDefense refusal leaving a half-applied rewrite, not against a
 * crash or I/O error doing the same.
 */
export function writeNotesAllOrNothingGuarded(
  entries: readonly NoteRewriteEntry[],
  config: VaultMemoryDefenseConfig | undefined,
  opts: { metrics?: MetricsRecorder } = {},
): Array<{ path: string; content: string; redactions: number }> {
  const scanned = entries.map((e) => {
    const scan = enforceMemoryDefenseOnNoteWrite(config, e.path, e.content, opts);
    return { abs: e.abs, path: e.path, content: scan.content, redactions: scan.redactions };
  });
  for (const s of scanned) writeNoteAtomic(s.abs, s.content, false);
  return scanned.map(({ path, content, redactions }) => ({ path, content, redactions }));
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
 * Soft-delete: move a note into the vault's `.trash/` mirror (Obsidian trash). Returns the
 * vault-relative trash path. A name collision gets a ` (n)` suffix, chosen by the no-replace move
 * itself refusing an occupied name (no check-then-rename window). A symlinked `.trash` (or any
 * symlinked component) is refused, never followed.
 */
export function trashNote(root: string, relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  const slash = relPath.lastIndexOf("/");
  const stem = dot > slash ? relPath.slice(0, dot) : relPath;
  const ext = dot > slash ? relPath.slice(dot) : "";
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

/** Put a file trashed by {@link trashNote} back at `destAbs` (rollback of a failed write). Same
 *  no-follow, no-replace move as the trash leg: a re-created path throws note_exists. */
export function restoreTrashed(root: string, trashedRel: string, destAbs: string): void {
  moveNoReplace(join(root, trashedRel), destAbs);
}

export function hardDelete(abs: string): void {
  rmSync(abs, { force: true });
}
