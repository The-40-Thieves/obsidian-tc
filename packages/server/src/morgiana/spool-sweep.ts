// Retention for the MORGIANA event spool: <cacheDir>/<vault>/morgiana-events-<YYYY-MM-DD>.jsonl.
//
// The emitter rotates by UTC day and appends with O_APPEND (appendFileSync, one open per event),
// so every writer, in this process or another, is already safe against rotation: a finished day is
// a file nothing appends to any more. That leaves whole-file deletion of finished days, and this
// file does only that. Nothing is ever truncated or rewritten, so an event is either wholly in a
// file or not there.
//
// Two independent bounds, both by whole file:
//   age    retentionDays: a file whose day AND mtime are both older than the window. 0 = off.
//   size   maxBytes: per vault directory, delete the oldest day files until the total fits.
//          Absent = off.
//
// NEVER deleted, by either bound:
//   - the file for today's UTC date, or any later date: the emitter is appending to it, and a
//     tailer (MORGIANA) is reading it;
//   - a file modified within the last hour, whatever its name: at UTC midnight an event whose time
//     was computed a moment before can still land in yesterday's file;
//   - anything that is not a regular file named exactly like a spool file directly inside a
//     vault directory. Symlinks (file or directory) are inspected with lstat and skipped, never
//     followed, so a link planted in the spool cannot redirect a delete; there is no recursion, and
//     the names come from readdir matched against a fixed pattern, so no path is ever built from
//     anything else.
// A missing or unreadable directory is a no-op, and a file that vanishes between readdir and
// unlink is skipped.
import { type Dirent, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Scheduler } from "../scheduler/scheduler";
import { SPOOL_FILE_RE } from "./emitter";

export interface SpoolSweepCounts {
  /** Files deleted because they aged out. */
  files_age: number;
  /** Files deleted to bring a vault's spool back under `maxBytes`. */
  files_size: number;
  /** Bytes freed by both. */
  bytes: number;
}

export interface SpoolSweepOptions {
  now: number;
  /** 0 = no age bound. */
  retentionDays: number;
  /** Absent = no size bound. */
  maxBytes?: number;
}

const DAY_MS = 86_400_000;
/** A file touched this recently is treated as being written to. */
const ACTIVE_GRACE_MS = 3_600_000;

interface SpoolFile {
  path: string;
  /** UTC day the name carries, as ms at 00:00. */
  dayMs: number;
  size: number;
  mtimeMs: number;
}

/** The spool files directly inside `dir`: regular files only (lstat), matching the emitter's name. */
function listSpoolFiles(dir: string): SpoolFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SpoolFile[] = [];
  for (const name of entries) {
    const m = SPOOL_FILE_RE.exec(name);
    if (m === null) continue;
    const dayMs = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(dayMs)) continue;
    try {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isFile()) out.push({ path, dayMs, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished between readdir and lstat */
    }
  }
  return out.sort((a, b) => a.dayMs - b.dayMs || (a.path < b.path ? -1 : 1));
}

/** Delete every file in `victims`; returns the count and bytes actually removed. */
function remove(victims: readonly SpoolFile[]): { n: number; bytes: number } {
  let n = 0;
  let bytes = 0;
  for (const f of victims) {
    try {
      rmSync(f.path, { force: true });
      n += 1;
      bytes += f.size;
    } catch {
      /* permissions, or a racing writer on this platform: skip and keep sweeping */
    }
  }
  return { n, bytes };
}

/** Prune the spool under `cacheDir` by age and size, as described in this file's header. */
export function sweepSpool(cacheDir: string, opts: SpoolSweepOptions): SpoolSweepCounts {
  const out: SpoolSweepCounts = { files_age: 0, files_size: 0, bytes: 0 };
  let vaults: Dirent[];
  try {
    vaults = readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const todayMs = Math.floor(opts.now / DAY_MS) * DAY_MS;
  const cutoff = opts.now - opts.retentionDays * DAY_MS;
  const protectedFile = (f: SpoolFile): boolean =>
    f.dayMs >= todayMs || f.mtimeMs > opts.now - ACTIVE_GRACE_MS;
  for (const v of vaults) {
    if (!v.isDirectory()) continue; // a symlink to a directory reports false here
    let files = listSpoolFiles(join(cacheDir, v.name));
    if (opts.retentionDays > 0) {
      const aged = files.filter(
        (f) => !protectedFile(f) && f.dayMs + DAY_MS <= cutoff && f.mtimeMs < cutoff,
      );
      const r = remove(aged);
      out.files_age += r.n;
      out.bytes += r.bytes;
      const gone = new Set(aged.map((f) => f.path));
      files = files.filter((f) => !gone.has(f.path));
    }
    if (opts.maxBytes !== undefined) {
      let total = files.reduce((a, f) => a + f.size, 0);
      const victims: SpoolFile[] = [];
      for (const f of files) {
        if (total <= opts.maxBytes) break;
        if (protectedFile(f)) continue;
        victims.push(f);
        total -= f.size;
      }
      const r = remove(victims);
      out.files_size += r.n;
      out.bytes += r.bytes;
    }
  }
  return out;
}

export interface SpoolSweepDeps extends Omit<SpoolSweepOptions, "now"> {
  cacheDir: string;
  intervalMs: number;
  now?: () => number;
  onSweep?: (counts: SpoolSweepCounts) => void;
  onError?: (e: unknown) => void;
}

/** Register the spool sweep as its own job on the shared scheduler. */
export function registerSpoolSweep(scheduler: Scheduler, deps: SpoolSweepDeps): void {
  const { cacheDir, intervalMs, now, onSweep, onError, ...opts } = deps;
  scheduler.register({
    name: "morgiana-spool-sweep",
    intervalMs,
    run: () => onSweep?.(sweepSpool(cacheDir, { ...opts, now: (now ?? Date.now)() })),
    onError: (e) => onError?.(e),
  });
}
