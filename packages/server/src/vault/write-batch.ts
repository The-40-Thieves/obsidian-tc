// A batch of note writes that lands as a unit on every error this process can catch, in three steps
// that keep the step most likely to fail (a full disk) away from the vault:
//   1. STAGE: every note's bytes go to a synced temp file next to it. Nothing is replaced yet, so
//      a failure here discards the temp files and leaves the vault as it was.
//   2. `beforeCommit` runs (the caller's durable intent record: write provenance marks the batch
//      pending here), then
//   3. COMMIT: the renames run back to back, synchronously. Immediately before replacing an existing
//      note its bytes are hashed again and compared with the ones the batch was planned from, so an
//      edit that landed after planning aborts the whole batch instead of being overwritten.
// A failure in step 3 restores the notes already replaced, but only those still holding exactly what
// this batch wrote: a note someone edited since is left alone and reported, and a page someone else
// recreated is never deleted.
//
// What this is NOT: crash-atomic. A process killed between two renames leaves the earlier notes
// replaced, which is why the caller records its intent before step 3 and snapshots every note it
// replaces. And the re-hash narrows the window for an edit by another PROCESS to the gap between
// the hash and the rename; POSIX has no conditional rename, so it cannot close it.
import { existsSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import {
  hardDelete,
  readNote,
  type StagedWrite,
  stageNoteWrite,
  writeNoteAtomic,
} from "./notes-io";
import { contentHash } from "./paths";

export interface BatchWrite {
  /** Absolute path, already resolved and ACL-checked by the caller. */
  abs: string;
  /** Vault-relative path, for error details. */
  rel: string;
  content: string;
  /** The raw bytes the note had when the batch was planned; null: it did not exist (a create). */
  prevRaw: string | null;
}

export interface BatchHooks {
  /** Runs after every temp file is staged and before the first note is replaced. A throw here
   *  discards the staged files and aborts the batch. */
  beforeCommit?: () => void;
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
      rmdirSync(d);
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
      const madeDirs = w.prevRaw === null ? missingDirs(w.abs) : [];
      const s = stageNoteWrite(w.abs, w.content, true, { exclusive: w.prevRaw === null });
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
  } catch (cause) {
    for (const s of staged) if (!done.includes(s)) s.staged.discard();
    const stuck: string[] = [];
    const diverged: string[] = [];
    for (const s of [...done].reverse()) {
      const { w } = s;
      try {
        const now = currentHash(w.abs);
        if (now === contentHash(w.content)) {
          if (w.prevRaw === null) {
            hardDelete(w.abs);
            removeMadeDirs(s.madeDirs);
          } else writeNoteAtomic(w.abs, w.prevRaw, false);
        } else if (now !== null || w.prevRaw !== null) diverged.push(w.rel);
        // else: a created page that is already gone; there is nothing to undo
      } catch {
        stuck.push(w.rel);
      }
    }
    removeMadeDirs(staged.filter((s) => !done.includes(s)).flatMap((s) => s.madeDirs));
    if (stuck.length > 0 || diverged.length > 0)
      throw err.internalError(
        "a write failed and some earlier writes were not undone; restore these notes with restore_note",
        {
          paths: [...stuck, ...diverged],
          ...(diverged.length > 0 ? { changed_since_written: diverged } : {}),
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      );
    throw cause;
  }
}
