// Background recovery for notes_fts after a transient lock (GH #1209 follow-up). ensureNotesFts
// records a `recovering` status instead of memoizing false; this retries it on the status's own
// backoff, bounded by FTS_MAX_ATTEMPTS, so a lock that clears lets later searches use FTS without a
// restart. It starts behind the first client's `initialize` (deferBootWork), like the embedder
// warmup, and uses plain unref'd timers: no job system of its own.

import type { Database } from "../db/types";
import { BOOT_WARMUP_MAX_WAIT_MS, deferBootWork } from "../runtime/boot-helpers";
import { ensureNotesFts } from "./fts";
import { FTS_MAX_ATTEMPTS, type FtsStatus, ftsRecord, ftsStatus, subscribeFts } from "./fts-status";

export interface FtsMonitor {
  status(): FtsStatus;
  /** Live: false while recovering or unavailable, true the moment a retry succeeds. */
  available(): boolean;
  /** Starts retrying behind `initialized` or the cap. `onRecovered` runs once per recovery (the
   *  runtime passes a reconcile, which backfills the rows written while FTS was off). */
  schedule(opts: {
    initialized: Promise<void>;
    maxWaitMs?: number;
    onRecovered?: () => void;
  }): () => void;
  cancel(): void;
  /** The `metadataIndex` the search tools read. `hasFts` is a getter, so a recovery is seen by the
   *  next search instead of a boolean captured at wiring time. */
  metadataIndex(ready: () => boolean): { readonly hasFts: boolean; ready: () => boolean };
}

const defaultLog = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

export function createFtsMonitor(
  db: Database,
  opts: { now?: () => number; log?: (msg: string) => void } = {},
): FtsMonitor {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? defaultLog;
  let started = false;
  let cancelled = false;
  let exhaustedLogged = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onRecovered: (() => void) | undefined;
  let cancelDeferred = (): void => {};

  const arm = (): void => {
    if (!started || cancelled || timer) return;
    const r = ftsRecord(db);
    if (r?.kind !== "transient") return;
    if (r.attempts >= FTS_MAX_ATTEMPTS) {
      if (exhaustedLogged) return;
      exhaustedLogged = true;
      log(
        `obsidian-tc: notes_fts still locked after ${r.attempts} attempts (${r.lastError}); full-text search stays on disk scans until an index write retries it`,
      );
      return;
    }
    timer = setTimeout(
      () => {
        timer = undefined;
        ensureNotesFts(db, { now, force: true });
        arm();
      },
      Math.max(0, r.nextRetryAt - now()),
    );
    timer.unref();
  };

  const unsubscribe = subscribeFts(db, (next, prev) => {
    if (next.kind === "transient" && prev?.kind !== "transient") {
      log(
        `obsidian-tc: notes_fts unavailable (${next.lastError}); retrying in the background, searches use disk scans meanwhile`,
      );
    }
    if (next.kind === "transient") arm();
    if (next.kind === "available" && prev && prev.kind !== "available") {
      log("obsidian-tc: notes_fts recovered; full-text search is on again");
      if (started && !cancelled) onRecovered?.();
    }
    if (
      next.kind === "terminal" &&
      (next.reason === "provision_failed" || next.reason === "integrity_failed")
    ) {
      log(`obsidian-tc: notes_fts failed (${next.reason}: ${next.lastError ?? "unknown"})`);
    }
  });

  // A failure that happened before this monitor existed (the boot probe) still has to be loud.
  const initial = ftsRecord(db);
  if (initial?.kind === "transient") {
    log(
      `obsidian-tc: notes_fts unavailable (${initial.lastError}); retrying in the background, searches use disk scans meanwhile`,
    );
  } else if (
    initial?.kind === "terminal" &&
    (initial.reason === "provision_failed" || initial.reason === "integrity_failed")
  ) {
    log(`obsidian-tc: notes_fts failed (${initial.reason}: ${initial.lastError ?? "unknown"})`);
  }

  const cancel = (): void => {
    cancelled = true;
    cancelDeferred();
    if (timer) clearTimeout(timer);
    timer = undefined;
    unsubscribe();
  };

  return {
    status: () => ftsStatus(db),
    available: () => ftsRecord(db)?.kind === "available",
    schedule: (s) => {
      onRecovered = s.onRecovered;
      cancelDeferred = deferBootWork(
        () => {
          started = true;
          arm();
        },
        { initialized: s.initialized, maxWaitMs: s.maxWaitMs ?? BOOT_WARMUP_MAX_WAIT_MS },
      );
      return cancel;
    },
    cancel,
    metadataIndex: (ready) => ({
      get hasFts() {
        return ftsRecord(db)?.kind === "available";
      },
      ready,
    }),
  };
}
