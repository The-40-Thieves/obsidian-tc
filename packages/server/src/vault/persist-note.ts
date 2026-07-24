// THE-562 P1.6: the governed note-write sequence, shared by write_note and reflect.persist so the
// two cannot drift. A raw writeFileSync bypasses the snapshot (no recovery point on overwrite), the
// atomic tmp+rename (a reader can catch a torn file), and index-on-write + generation bump (the note
// is never indexed and stale caches are not invalidated). Route derived-note writes through here.
import type { Database } from "../db/types";
import { noteExists, readNote, writeNoteAtomic } from "./notes-io";
import { resolveVaultPath } from "./paths";
import { captureSnapshot } from "./snapshots";

export interface GovernedWriteDeps {
  snapshots?: { enabled: boolean; retention: number };
  reindex?: (vaultId: string, path: string, content: string) => void;
  now?: () => number;
}

export interface GovernedWriteParams {
  vaultId: string;
  root: string;
  rel: string;
  content: string;
  op: string;
  createDirs: boolean;
}

export function persistGovernedNote(
  db: Database,
  deps: GovernedWriteDeps,
  params: GovernedWriteParams,
): void {
  const abs = resolveVaultPath(params.root, params.rel);
  const ex = noteExists(abs);
  if (ex.exists) {
    const prev = readNote(abs);
    captureSnapshot(db, deps.snapshots, params.vaultId, params.rel, prev.raw, params.op, deps.now ?? Date.now);
  }
  writeNoteAtomic(abs, params.content, params.createDirs);
  deps.reindex?.(params.vaultId, params.rel, params.content);
}
