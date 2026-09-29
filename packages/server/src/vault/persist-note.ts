// THE-562 P1.6: the governed note-write sequence, shared by write_note and reflect.persist so the
// two cannot drift. A raw writeFileSync bypasses the snapshot (no recovery point on overwrite), the
// atomic tmp+rename (a reader can catch a torn file), and index-on-write + generation bump (the note
// is never indexed and stale caches are not invalidated). Route derived-note writes through here.
import type { VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";
import { enforceMemoryDefenseOnNoteWrite } from "../experiential/memory-defense";
import type { MetricsRecorder } from "../metrics/registry";
import { noteExists, readNote, writeNoteAtomic } from "./notes-io";
import { resolveVaultPath } from "./paths";
import { captureSnapshot } from "./snapshots";

export interface GovernedWriteDeps {
  snapshots?: { enabled: boolean; retention: number };
  reindex?: (vaultId: string, path: string, content: string) => void;
  now?: () => number;
  /** a caller that has NOT already scanned `params.content` itself (write_note pre-scans
   *  before calling this) passes its vault's memoryDefense config here so this governed-write
   *  chokepoint scans/refuses before persisting — reflect.persist's model-synthesized note is the
   *  motivating caller. Absent -> no scan (`off`-mode passthrough), same default as every other
   *  memoryDefense seam. A caller that already scanned may omit this; re-scanning already-redacted
   *  content is idempotent, not harmful, so passing it anyway is also safe. */
  memoryDefense?: VaultMemoryDefenseConfig;
  metrics?: MetricsRecorder;
  /** THE-572: `ctx.markEffectCommitted` from the calling handler's dispatch, when the call carries
   *  an idempotency key. This sequence is multi-step — the snapshot ledger row commits before the
   *  note is written — so without the signal a `writeNoteAtomic` throw released the claim and a
   *  retry captured a SECOND snapshot of the same unchanged content, consuming a retention slot
   *  that would otherwise hold a genuinely distinct recovery point. */
  markEffectCommitted?: () => void;
}

export interface GovernedWriteParams {
  vaultId: string;
  root: string;
  rel: string;
  content: string;
  op: string;
  createDirs: boolean;
}

/** `content`/`redactions` mirror `enforceMemoryDefenseOnNoteWrite`'s own return shape — the
 *  persisted (possibly redacted) content, and how much of it was redacted (0 when
 *  `deps.memoryDefense` is absent/`off`, or a caller pre-scanned and passed nothing to redact
 *  here). Most existing callers (write_note) ignore the return value; they already scanned. */
export function persistGovernedNote(
  db: Database,
  deps: GovernedWriteDeps,
  params: GovernedWriteParams,
): { content: string; redactions: number } {
  // reflect.persist (a model-synthesized note, never pre-scanned by its caller) is the
  // gap this closes — scan the FINAL persisted body before anything below touches disk, same
  // "vault-wide once mode !== off" policy every other note-write guard applies.
  const scan = enforceMemoryDefenseOnNoteWrite(deps.memoryDefense, params.rel, params.content, {
    metrics: deps.metrics,
  });
  const content = scan.content;
  const abs = resolveVaultPath(params.root, params.rel);
  const ex = noteExists(abs);
  // THE-572: everything above is a read; the snapshot below is the first durable effect.
  deps.markEffectCommitted?.();
  if (ex.exists) {
    const prev = readNote(abs);
    captureSnapshot(
      db,
      deps.snapshots,
      params.vaultId,
      params.rel,
      prev.raw,
      params.op,
      deps.now ?? Date.now,
    );
  }
  writeNoteAtomic(abs, content, params.createDirs);
  deps.reindex?.(params.vaultId, params.rel, content);
  return { content, redactions: scan.redactions };
}
