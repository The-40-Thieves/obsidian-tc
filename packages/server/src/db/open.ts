import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";
import { basename, join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Database, OpenOptions } from "./types";

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Open a SQLite-backed Database for the current runtime: bun:sqlite under Bun,
 * better-sqlite3 under Node. Adapters are imported dynamically so the inactive
 * runtime's native module is never evaluated. node:sqlite is the last-resort fallback when
 * better-sqlite3 cannot be resolved (e.g. the packed .mcpb); CI's Node 24 legs remove better-sqlite3
 * so the suite also runs on it.
 *
 * @param busyTimeoutMs THE-935: config's `db.busyTimeoutMs`, forwarded to whichever adapter opens
 *   the connection. Omitted falls back to DEFAULT_BUSY_TIMEOUT_MS (pragmas.ts).
 * @param opts THE-1039 fix round 1 (F2): `{ readonly: true }` opens `SQLITE_OPEN_READONLY` and
 *   skips every write-capable pragma (`journal_mode` chief among them) — for a caller that only
 *   ever means to INSPECT a database (`compact --dry-run`, `--into`'s live-side read, doctor's
 *   `probeDbSpace`), never to change its bytes or its journal mode as a side effect of looking.
 */
export async function openDatabase(
  path: string,
  busyTimeoutMs?: number,
  opts: OpenOptions = {},
): Promise<Database> {
  if (isBun()) {
    const { openBunSqlite } = await import("./bun-sqlite");
    return openBunSqlite(path, busyTimeoutMs, opts);
  }
  // Node: prefer better-sqlite3 (native, fastest). Fall back to the built-in node:sqlite ONLY when
  // better-sqlite3 cannot be resolved — e.g. the self-contained .mcpb bundle, which ships no
  // node_modules. A genuine DB error is not swallowed; only a resolution/binding failure falls back.
  try {
    const { openBetterSqlite3 } = await import("./node-better-sqlite3");
    return await openBetterSqlite3(path, busyTimeoutMs, opts);
  } catch (err) {
    if (!isBetterSqlite3Unavailable(err)) throw err;
    const { openNodeSqlite } = await import("./node-node-sqlite");
    return openNodeSqlite(path, busyTimeoutMs, opts);
  }
}

/**
 * THE-935 fix round 1: the ONE seam a config-scoped caller opening `<cacheDir>/<filename>` should
 * go through, so a future call site cannot silently forget `cfg.db.busyTimeoutMs` the way ~19 call
 * sites originally did (bare `openDatabase(join(cfg.cacheDir, filename))`, always the default).
 * Structural, not a reminder: the parameter is `cfg` itself, not a number a caller could omit —
 * `packages/server/test/db-busy-timeout-inventory.test.ts` also source-scans every remaining
 * direct `openDatabase(` call site under `src/` and fails the build on a new one that drops the
 * second argument, for the sites (doctor's probes, note-summary-scale, the sandbox VACUUM INTO
 * stage) that only ever hold a bare `cacheDir` string, not a full `ServerConfig`, and so cannot
 * route through this helper.
 *
 * `ownerOnly` (auth.db, oauth.db) tightens the file and its -wal/-shm to 0600 twice: before the
 * open, through a descriptor, and again after it. See `tightenBeforeOpen` and `tightenAfterOpen`.
 * Nothing here throws on a permission problem: each file that cannot be tightened is named once,
 * by basename and reason, on one stderr line, and the database still opens.
 *
 * `hooks.afterPreCheck` is a test seam: it runs in the window between the two passes, where a file
 * can be swapped. Production passes nothing.
 */
export async function openConfiguredDatabase(
  cfg: Pick<ServerConfig, "cacheDir" | "db">,
  filename: string,
  opts: OpenOptions = {},
  hooks: { afterPreCheck?: (path: string) => void } = {},
): Promise<Database> {
  const path = join(cfg.cacheDir, filename);
  if (!opts.ownerOnly || opts.readonly) return openDatabase(path, cfg.db.busyTimeoutMs, opts);
  // SQLite gives a new -wal/-shm the mode of the main file, so creating that one 0600 first covers
  // every sidecar born later. O_EXCL means an existing name, a symlink included, is never created
  // through: it is left to the passes below, which tighten a regular file and refuse a link.
  createOwnerOnly(path);
  // Win32 has no owner-only mode: a chmod there would only toggle the read-only flag.
  const posix = process.platform !== "win32";
  const notes: Notes = new Map();
  if (posix) {
    for (const suffix of SUFFIXES) tightenBeforeOpen(path + suffix, notes);
  }
  hooks.afterPreCheck?.(path);
  // The second pass is by path, not by descriptor. SQLite holds POSIX locks on -wal and -shm for as
  // long as the connection is open, and closing any descriptor on a file drops every lock this
  // process holds on it, so the open connection must not be given a descriptor close.
  return openDatabase(path, cfg.db.busyTimeoutMs, opts).finally(() => {
    if (posix) {
      for (const suffix of SUFFIXES) tightenAfterOpen(path + suffix, notes);
    }
    if (notes.size > 0) {
      const parts = [...notes].map(([name, text]) => `${name} ${text}`);
      process.stderr.write(`[db] owner-only: ${parts.join("; ")}\n`);
    }
  });
}

const SUFFIXES = ["", "-wal", "-shm"] as const;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const TIGHTENED = "tightened to 0600";
const REFUSED_LINK = "refused: a symbolic link, not followed; its target keeps its mode";
const CONTROL = /\p{Cc}/gu;

/** One entry per file, keyed by basename. A failure is sticky: a later pass that succeeds does not
 *  hide that an earlier one could not tighten the file. */
type Notes = Map<string, string>;

function note(notes: Notes, file: string, text: string, failed = false): void {
  const name = basename(file).replace(CONTROL, "");
  if (failed || !notes.has(name)) notes.set(name, text);
}

function errorCode(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? "unknown error";
}

function notTightened(err: unknown): string {
  return `not tightened: ${errorCode(err).replace(CONTROL, "")}`;
}

function createOwnerOnly(path: string): void {
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
    closeSync(openSync(path, flags, 0o600));
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
  }
}

/** Group or other has a bit set. Predicate only: the caller decides what to do about it. */
function isLooser(st: Stats): boolean {
  return (st.mode & 0o077) !== 0;
}

/** Why a looser file must not be chmodded, or undefined when it may be. */
function refusalFor(st: Stats): string | undefined {
  if (!st.isFile()) return "refused: not a regular file";
  if (st.nlink !== 1)
    return `refused: a hard link (${st.nlink} names), so other names keep the mode`;
  if (st.uid !== process.getuid?.()) return "refused: owned by another user";
  return undefined;
}

/**
 * Before the open: open with O_NOFOLLOW (a symlink is refused, never followed), check the open
 * descriptor's inode, and fchmod it. A missing sidecar is not an error.
 */
function tightenBeforeOpen(file: string, notes: Notes): void {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDWR | NOFOLLOW);
  } catch (err) {
    if (errorCode(err) === "ELOOP") note(notes, file, REFUSED_LINK, true);
    else if (errorCode(err) !== "ENOENT") note(notes, file, notTightened(err), true);
    return;
  }
  try {
    const st = fstatSync(fd);
    if (!isLooser(st)) return;
    const refusal = refusalFor(st);
    if (refusal) {
      note(notes, file, refusal, true);
    } else {
      fchmodSync(fd, 0o600);
      note(notes, file, TIGHTENED);
    }
  } catch (err) {
    note(notes, file, notTightened(err), true);
  } finally {
    closeSync(fd);
  }
}

/**
 * After the open: catch a file swapped in between the two passes. lstat, not stat, so a symlink
 * that appeared in the window is refused rather than followed.
 */
function tightenAfterOpen(file: string, notes: Notes): void {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) {
      note(notes, file, REFUSED_LINK, true);
      return;
    }
    if (!isLooser(st)) return;
    const refusal = refusalFor(st);
    if (refusal) {
      note(notes, file, refusal, true);
      return;
    }
    chmodSync(file, 0o600);
    note(notes, file, TIGHTENED);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") note(notes, file, notTightened(err), true);
  }
}

function isBetterSqlite3Unavailable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /cannot find (module|package)|could not locate the bindings|better[_-]?sqlite3/i.test(msg);
}
