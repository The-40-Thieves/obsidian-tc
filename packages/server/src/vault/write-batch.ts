// A batch of note writes that lands as a unit on every error this process can catch, in three steps
// that keep the step most likely to fail (a full disk) away from the vault:
//   1. STAGE: every note's bytes go to a synced temp file next to it. Nothing is replaced yet, so
//      a failure here discards the temp files and leaves the vault as it was.
//   2. `beforeCommit` runs (the caller's durable intent record: write provenance marks the batch
//      pending here), then
//   3. COMMIT: the renames run back to back, synchronously. Immediately before replacing an existing
//      note its bytes are hashed again and compared with the ones the batch was planned from, so an
//      edit that landed after planning aborts the whole batch instead of being overwritten. A
//      move's SOURCE is dropped as the very last step (`removals`), and only if it still holds the
//      bytes the move was planned from: otherwise it is kept and the batch rolls back like any
//      other failure, so an edit that lands after the final recheck is never deleted.
// A failure in step 3 restores the notes already replaced, but only those still holding exactly what
// this batch wrote: a note someone edited since is left alone and reported, and a page someone else
// recreated is never deleted. Each undo moves the note aside first (a rename takes whatever is
// there at that instant) and hashes the moved file, so what it then drops or replaces is verified,
// not merely observed a moment earlier; see `undoWrittenNote`. When anything could not be put back
// the error says so (`isIncompleteRollback`) and the caller must keep its snapshots.
//
// What this is NOT: crash-atomic. A process killed between two renames leaves the earlier notes
// replaced, which is why the caller records its intent before step 3 and snapshots every note it
// replaces. And the re-hash narrows the window for an edit by another PROCESS to the gap between
// the hash and the rename; POSIX has no conditional rename, so it cannot close it. The rollback
// has the mirror-image residual: while a note is moved aside its name is empty, and a note another
// process writes there in that gap is kept, so the pre-image then lives only in the snapshot.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import {
  hardDelete,
  moveNoReplace,
  readFileChecked,
  readNote,
  removeEmptyDir,
  type StagedWrite,
  stageNoteWrite,
  writeNoteAtomic,
} from "./notes-io";
import { contentHash } from "./paths";

/** `details.reason` of the error a batch throws when its rollback did not put everything back. */
export const ROLLBACK_INCOMPLETE = "rollback_incomplete";

/** True for that error: the pre-images the caller snapshotted are then the way back, keep them. */
export const isIncompleteRollback = (e: unknown): boolean =>
  e instanceof ObsidianTcError && e.details?.reason === ROLLBACK_INCOMPLETE;

export interface BatchWrite {
  /** Absolute path, already resolved and ACL-checked by the caller. */
  abs: string;
  /** Vault-relative path, for error details. */
  rel: string;
  content: string;
  /** The raw bytes the note had when the batch was planned; null: it did not exist (a create). */
  prevRaw: string | null;
  /** Make missing parent folders of a create; default true. A rewrite of an existing note passes
   *  false, so a note that vanished is an error rather than a recreated one. */
  createDirs?: boolean;
  /** The leaf existed and the caller just moved it aside (replaceDestination): re-creating it mints
   *  no NEW name, so the hostile-name refusal is skipped. */
  replacesExisting?: boolean;
}

/** A file the batch removes as its last step: a move's source. */
export interface BatchRemoval {
  /** Absolute path, already resolved and ACL-checked by the caller. */
  abs: string;
  /** Vault-relative path, for error details. */
  rel: string;
  /** What the file held when the move was planned: a note's text (compared by its decoded hash,
   *  as readNote reads it) or an attachment's exact bytes. */
  expected: string | Buffer;
}

export interface BatchHooks {
  /** Runs after every temp file is staged and before the first note is replaced. A throw here
   *  discards the staged files and aborts the batch. */
  beforeCommit?: () => void;
  /** Dropped after every write landed, each only if it still holds `expected`; see `removeUnchanged`. */
  removals?: readonly BatchRemoval[];
}

/** Directories above `abs` that do not exist yet, outermost first. */
function missingDirs(abs: string): string[] {
  const out: string[] = [];
  for (let d = dirname(abs); !existsSync(d) && dirname(d) !== d; d = dirname(d)) out.unshift(d);
  return out;
}

/** Remove the directories a batch made, innermost first; one that is not empty is not ours to force. */
function removeMadeDirs(dirs: readonly string[]): void {
  for (const d of [...dirs].reverse()) {
    try {
      removeEmptyDir(d);
    } catch {
      // not empty or already gone
    }
  }
}

/** The hash of what is on disk at `abs` now; null when nothing readable is there. */
function currentHash(abs: string): string | null {
  try {
    return readNote(abs).hash;
  } catch {
    return null;
  }
}

/** Drop a file we own; a name that will not go is only litter. */
function dropQuietly(abs: string): void {
  try {
    hardDelete(abs);
  } catch {
    // best-effort cleanup: nothing more to do if the removal fails
  }
}

/** How rolling back one note went: `undone` (the old state is back), `diverged` (the note no longer
 *  holds what the batch wrote, or someone made a new one: it was left alone), `stuck` (the undo
 *  itself failed; whatever is on disk was not deleted). */
type UndoOutcome = "undone" | "diverged" | "stuck";

/**
 * Undo a note a batch wrote, destroying nothing the batch did not write. The note is first moved
 * aside by a rename (atomic: it takes whatever is at `abs` at that instant), and only that moved
 * file is hashed: if it is exactly `writtenHash` it is dropped and the pre-image (`prevRaw`, or
 * nothing for a created page) put in its place with a no-replace create; if it is anything else it
 * is moved back with a no-replace link, so a note someone changed or recreated is never deleted or
 * overwritten, whenever in this sequence they did it. What stays open: while it is aside the name is
 * empty (a reader sees no note), and a note written to the name in that gap wins, the pre-image then
 * surviving only in the snapshot the caller took.
 */
function undoWrittenNote(abs: string, writtenHash: string, prevRaw: string | null): UndoOutcome {
  const aside = `${abs}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    moveNoReplace(abs, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return prevRaw === null ? "undone" : "diverged";
    return "stuck";
  }
  const putBack = (): UndoOutcome => {
    try {
      moveNoReplace(aside, abs);
      return "diverged";
    } catch {
      // A newer note holds the name (theirs stays), or the move failed: either way the moved-aside
      // bytes are kept, not deleted.
      return "stuck";
    }
  };
  let held: string | null = null;
  try {
    if (lstatSync(aside).isFile()) held = readNote(aside).hash;
  } catch {
    // unreadable aside file: `held` stays null, so the put-back path below runs
  }
  if (held !== writtenHash) return putBack();
  if (prevRaw === null) {
    dropQuietly(aside);
    return "undone";
  }
  try {
    writeNoteAtomic(abs, prevRaw, false, { exclusive: true });
  } catch (e) {
    // Someone created a note at the name while ours was aside: theirs wins. Anything else: put
    // ours back so the batch's own write is at least still there.
    if ((e as { code?: string }).code === "note_exists") {
      dropQuietly(aside);
      return "diverged";
    }
    putBack();
    return "stuck";
  }
  dropQuietly(aside);
  return "undone";
}

/** True when the file at `abs` holds exactly `expected`; a file that cannot be read does not. */
function holds(abs: string, expected: string | Buffer): boolean {
  try {
    return typeof expected === "string"
      ? readNote(abs).hash === contentHash(expected)
      : readFileChecked(abs).equals(expected);
  } catch {
    return false;
  }
}

/**
 * Remove the files a move leaves behind, but only those still holding what the move was planned
 * from. Same shape as `undoWrittenNote`: each file is first moved aside by a rename (atomic: it
 * takes whatever is at the name at that instant) and only that moved file is compared, so what is
 * dropped is verified, not merely observed a moment earlier. Nothing is dropped until EVERY file
 * verified, so a mismatch on one leaves all of them in place (the moved-aside ones are put back
 * with a no-replace move). A file already gone is already removed. A mismatch throws
 * `concurrent_modification`, which the batch turns into a rollback of its writes. Residual: while
 * a file is aside its name is empty, and a file another process writes there in that gap wins;
 * the moved-aside bytes are then kept, named in the error.
 */
function removeUnchanged(removals: readonly BatchRemoval[]): void {
  const aside: Array<{ r: BatchRemoval; tmp: string; suffix: string }> = [];
  const putBack = (): string[] => {
    const kept: string[] = [];
    for (const a of aside) {
      try {
        moveNoReplace(a.tmp, a.r.abs);
      } catch {
        kept.push(`${a.r.rel}${a.suffix}`);
      }
    }
    return kept;
  };
  let changed: string | undefined;
  let failure: unknown;
  for (const r of removals) {
    const suffix = `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    const tmp = `${r.abs}${suffix}`;
    try {
      moveNoReplace(r.abs, tmp);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      failure = e;
      break;
    }
    aside.push({ r, tmp, suffix });
    if (!holds(tmp, r.expected)) {
      changed = r.rel;
      break;
    }
  }
  if (changed === undefined && failure === undefined) {
    for (const a of aside) dropQuietly(a.tmp);
    return;
  }
  const kept = putBack();
  if (kept.length > 0)
    throw err.internalError(
      "a source changed before it could be removed and could not be put back under its name; its current bytes are kept beside it",
      { reason: ROLLBACK_INCOMPLETE, paths: kept },
    );
  if (failure !== undefined) throw failure;
  throw err.concurrentModification(
    `${changed} changed since it was read; it was kept and nothing was moved. Re-read and move again`,
    { path: changed },
  );
}

interface Staged {
  w: BatchWrite;
  madeDirs: string[];
  staged: StagedWrite;
}

export function applyWriteBatch(writes: readonly BatchWrite[], hooks: BatchHooks = {}): void {
  const staged: Staged[] = [];
  const abandon = (): void => {
    for (const s of staged) s.staged.discard();
    for (const s of [...staged].reverse()) removeMadeDirs(s.madeDirs);
  };
  try {
    for (const w of writes) {
      const createDirs = w.createDirs ?? true;
      const madeDirs = w.prevRaw === null && createDirs ? missingDirs(w.abs) : [];
      const s = stageNoteWrite(w.abs, w.content, createDirs, {
        exclusive: w.prevRaw === null,
        ...(w.replacesExisting ? { replacesExisting: true } : {}),
      });
      staged.push({ w, madeDirs, staged: s });
    }
    hooks.beforeCommit?.();
  } catch (e) {
    abandon();
    throw e;
  }

  const done: Staged[] = [];
  try {
    for (const s of staged) {
      if (s.w.prevRaw !== null) {
        const expected = contentHash(s.w.prevRaw);
        const actual = currentHash(s.w.abs);
        if (actual !== expected)
          throw err.concurrentModification(
            `${s.w.rel} changed since it was read; nothing was kept. Re-read, re-draft and commit again`,
            { path: s.w.rel, expected, actual: actual ?? "missing" },
          );
      }
      s.staged.commit();
      done.push(s);
    }
    if (hooks.removals?.length) removeUnchanged(hooks.removals);
  } catch (cause) {
    for (const s of staged) if (!done.includes(s)) s.staged.discard();
    const stuck: string[] = [];
    const diverged: string[] = [];
    for (const s of [...done].reverse()) {
      const { w } = s;
      let outcome: UndoOutcome;
      try {
        outcome = undoWrittenNote(w.abs, contentHash(w.content), w.prevRaw);
      } catch {
        outcome = "stuck";
      }
      if (outcome === "undone" && w.prevRaw === null) removeMadeDirs(s.madeDirs);
      else if (outcome === "diverged") diverged.push(w.rel);
      else if (outcome === "stuck") stuck.push(w.rel);
    }
    removeMadeDirs(staged.filter((s) => !done.includes(s)).flatMap((s) => s.madeDirs));
    if (stuck.length > 0 || diverged.length > 0)
      throw err.internalError(
        "a write failed and some earlier writes were not undone; restore these notes with restore_note",
        {
          reason: ROLLBACK_INCOMPLETE,
          paths: [...stuck, ...diverged],
          ...(diverged.length > 0 ? { changed_since_written: diverged } : {}),
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      );
    throw cause;
  }
}
