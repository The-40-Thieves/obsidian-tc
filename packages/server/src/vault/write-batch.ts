// A batch of note writes that either all land or all are undone. `writeNotesAllOrNothingGuarded`
// (notes-io.ts) is only scan-atomic: an I/O failure half way leaves the earlier notes rewritten.
// This is the write-atomic counterpart for a caller that has the whole batch computed up front:
// each write is the usual atomic temp + rename, and a failure on write N restores writes 1..N-1 from
// the bytes read before the batch started (an overwritten note gets its old content back, a created
// note is removed, with the directories this batch made).
//
// "Undone" is best effort across a crash: a process killed mid-batch leaves whatever had landed,
// which is why the callers also take a snapshot per overwritten note before writing it.
import { existsSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { hardDelete, writeNoteAtomic } from "./notes-io";

export interface BatchWrite {
  /** Absolute path, already resolved and ACL-checked by the caller. */
  abs: string;
  /** Vault-relative path, for error details. */
  rel: string;
  content: string;
  /** The raw bytes the note had when the batch was planned; null: it did not exist (a create). */
  prevRaw: string | null;
}

/** Directories above `abs` that do not exist yet, outermost first. */
function missingDirs(abs: string): string[] {
  const out: string[] = [];
  for (let d = dirname(abs); !existsSync(d) && dirname(d) !== d; d = dirname(d)) out.unshift(d);
  return out;
}

export function applyWriteBatch(
  writes: readonly BatchWrite[],
  /** Runs just before each write (the snapshot of the note it is about to replace). */
  before?: (w: BatchWrite) => void,
): void {
  const done: Array<{ w: BatchWrite; madeDirs: string[] }> = [];
  try {
    for (const w of writes) {
      before?.(w);
      const madeDirs = w.prevRaw === null ? missingDirs(w.abs) : [];
      writeNoteAtomic(w.abs, w.content, true, { exclusive: w.prevRaw === null });
      done.push({ w, madeDirs });
    }
  } catch (cause) {
    const stuck: string[] = [];
    for (const { w, madeDirs } of done.reverse()) {
      try {
        if (w.prevRaw === null) {
          hardDelete(w.abs);
          for (const d of madeDirs.reverse()) {
            try {
              rmdirSync(d);
            } catch {
              // not empty or already gone: the directory is not ours to force
            }
          }
        } else writeNoteAtomic(w.abs, w.prevRaw, false);
      } catch {
        stuck.push(w.rel);
      }
    }
    if (stuck.length > 0)
      throw err.internalError(
        "a write failed and some earlier writes could not be undone; restore these notes with restore_note",
        {
          paths: stuck,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      );
    throw cause;
  }
}
