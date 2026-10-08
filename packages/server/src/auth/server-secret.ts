// The per-server secret: one random 32-byte key under `<cacheDir>/server-secrets/`, created on first
// use, that authenticates state this server minted for itself (generated wiki page seals, HITL
// request-states). It is not a bearer credential and never verifies or signs a token.
//
// Consumers must not use it raw for two purposes: each derives its own key under its own label
// (the wiki seal HMACs with it under `obsidian-tc/wiki-generated/v1`; the elicit codec runs it
// through HKDF, see elicit-request-state.ts), so neither derived key can stand in for the other.
// The file keeps its original name, `wiki-generated.key`, so seals minted before this module
// existed stay valid and there is one secret to back up.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  createKeyFile,
  ensureKeysDir,
  existsNoFollow,
  KeyFileError,
  readKeyFile,
} from "./key-files";

const SECRET_DIR = "server-secrets";
const SECRET_FILE = "wiki-generated.key";
const KEY_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const REPAIR_LOCK_STALE_MS = 10_000;
const REPAIR_LOCK_WAIT_MS = 15_000;

/** Tunables for the corrupt-key repair. Production passes none; they exist so a test can shrink the
 *  lock timings and stall a repairer at a chosen point without waiting out the real ones.
 *  @internal */
export interface ServerSecretOptions {
  /** A repair lock with NO owner (its creator stalled or died before writing one) untouched this
   *  long is removed. A lock with an owner is never taken over on time. */
  staleMs?: number;
  /** How long to wait on another repairer before giving up with an error. */
  waitMs?: number;
  /** Runs right after the repairer has made the lock directory, before it writes its owner token (a test removes or replaces the lock here). */
  afterLockMade?: () => void;
  /** Runs after a waiter has judged the lock's holder dead, before it takes the lock over (a test swaps in a live lock here). */
  beforeTakeOver?: () => void;
  /** Runs after the repairer has judged the file corrupt and just before it replaces it (a test stalls a holder here). */
  beforeRepair?: () => void;
  /** Runs once the repairer has re-read the file as still corrupt, just before it moves it aside. */
  beforeMoveAside?: () => void;
  /** Runs while the file is moved aside, before the repairer links a key back in. */
  inMoveGap?: () => void;
}

const secretPath = (cacheDir: string): string => join(cacheDir, SECRET_DIR, SECRET_FILE);

// Callers branch on the structured reason, never on the message: it embeds the configured path.
const isCorrupt = (e: unknown): boolean =>
  e instanceof KeyFileError && (e.reason === "empty" || e.reason === "corrupt");

const isMissing = (e: unknown): boolean => e instanceof KeyFileError && e.reason === "missing";

const readValidated = (path: string): string => {
  let secret: string;
  try {
    secret = readKeyFile(path);
  } catch (e) {
    // A key others could read must be treated as disclosed: tightening the mode would adopt it
    // again, so the advice is to delete it (a new one is generated), not to chmod it.
    if (e instanceof KeyFileError && e.reason === "exposed") {
      throw new KeyFileError(
        `${e.message}. Do not just chmod it: it was readable by others, so treat it as disclosed. ` +
          "Stop every obsidian-tc process sharing this cacheDir, delete the file once, then restart " +
          "them (a new key is generated; pending confirmations are refused once, and generated wiki " +
          "pages read as edited, then regenerate)",
        e,
        "exposed",
      );
    }
    throw e;
  }
  if (!KEY_FORMAT.test(secret)) {
    throw new KeyFileError(
      `${path} is corrupt (expected one complete 32-byte base64url key)`,
      undefined,
      "corrupt",
    );
  }
  return secret;
};

const removeTemp = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // The publish/rename result is authoritative; a best-effort temp cleanup must not mask it.
  }
};

const newSecret = (): string => randomBytes(32).toString("base64url");

const tempPath = (path: string): string =>
  `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;

/** Read the server secret without creating or repairing any state. */
export function readServerSecret(cacheDir: string): string | undefined {
  const path = secretPath(cacheDir);
  if (!existsNoFollow(path)) return undefined;
  return readIfPresent(path); // absent again if a repairer has it moved aside
}

/** Publish a fully written and fsynced temporary file with an atomic, no-replace hard link.
 *  Returns false when `to` already exists; any other failure (a missing directory) throws. */
function publishExclusive(tmp: string, to: string, contents: string): boolean {
  try {
    createKeyFile(tmp, contents);
    try {
      linkSync(tmp, to);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  } finally {
    removeTemp(tmp);
  }
}

function publishNew(path: string, secret: string): void {
  publishExclusive(tempPath(path), path, secret);
}

/** Read the key; `undefined` when the file is absent (a repairer has the corrupt one aside). */
function readIfPresent(path: string): string | undefined {
  try {
    return readValidated(path);
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** `rename`, riding out the brief sharing violation Windows raises while a waiting process has the
 *  corrupt file open for its validity poll. Bounded: a lock that never clears surfaces as the
 *  original error, not a hang. */
function renameOverBusy(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 100 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      sleep(10);
    }
  }
}

// The repair lock is a directory holding an `owner` file (mkdir is atomic). Whoever holds it is the
// only process that publishes a key or moves one aside, so a reader that finds the file absent waits
// for the lock instead of minting a key of its own into a repairer's gap.
//
// A lock that has an owner is NEVER taken over because time passed: a live holder can stall at any
// point (a stopped process, a starved runner) and then act on a view that others have since changed,
// so two instances could end up on two keys. It is taken over only when its holder is provably dead:
// same host and pid namespace, pid gone (or reused by a process with another start time). A holder
// on another host, or one we cannot judge, makes the waiter fail closed after `waitMs` with an error
// naming the lock to remove.
//
// The `owner` file is published complete and exclusively (written to a temp file, then linked), so
// an owner is never overwritten or half written, and a lost race (directory gone, owner present) is
// just a lost acquisition that retries without deleting anything. Removal never trusts the path
// alone: `rmdir` removes only an EMPTY directory, and a dead holder's owner is removed only by the
// one waiter holding a ticket named for that holder's unique token.
const ownerFile = (lock: string): string => join(lock, "owner");

interface Holder {
  token: string;
  pid: number;
  /** host, boot and pid namespace: a pid means something only inside the same scope */
  scope: string;
  /** process start time where the platform exposes it (Linux), to see through pid reuse */
  start?: string;
}

const TOKEN = /^[A-Za-z0-9._-]{1,80}$/;

const readSmall = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const readlinkOrUndefined = (path: string): string | undefined => {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
};

const processScope = (): string =>
  [
    hostname(),
    readSmall("/proc/sys/kernel/random/boot_id")?.trim(),
    readlinkOrUndefined("/proc/self/ns/pid"),
  ]
    .filter((p) => p !== undefined && p !== "")
    .join("|");

/** Field 22 of /proc/<pid>/stat (jiffies since boot); the comm field may hold spaces and parens. */
const startTime = (pid: number): string | undefined => {
  const stat = readSmall(`/proc/${pid}/stat`);
  return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};

/** The owner record for `token`, naming this process. @internal */
export const ownerRecord = (token: string): Holder => {
  const start = startTime(process.pid);
  return { token, pid: process.pid, scope: processScope(), ...(start ? { start } : {}) };
};

const parseHolder = (text: string | undefined): Holder | undefined => {
  if (text === undefined) return undefined;
  try {
    const h = JSON.parse(text) as Partial<Holder> | null;
    if (
      h &&
      typeof h.token === "string" &&
      TOKEN.test(h.token) &&
      Number.isInteger(h.pid) &&
      (h.pid as number) > 0 &&
      typeof h.scope === "string" &&
      (h.start === undefined || typeof h.start === "string")
    ) {
      return h as Holder;
    }
  } catch {
    // not a record this version wrote
  }
  return undefined;
};

/** True only when the holder is provably gone: our own scope, and the pid is free or now belongs to
 *  a process that started at a different time. Anything uncertain is "alive". */
const holderIsDead = (h: Holder): boolean => {
  if (h.scope !== processScope()) return false;
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
  const now = startTime(h.pid);
  return h.start !== undefined && now !== undefined && now !== h.start;
};

const ownsLock = (lock: string, token: string): boolean =>
  parseHolder(readSmall(ownerFile(lock)))?.token === token;

const lockIsStale = (lock: string, staleMs: number): boolean => {
  try {
    return Date.now() - statSync(lock).mtimeMs > staleMs;
  } catch {
    return false;
  }
};

/** Remove a lock this process holds. Throws when it cannot (a non-empty directory, a symlink): the
 *  caller then backs off instead of retrying hot. */
function removeLock(lock: string): void {
  try {
    unlinkSync(ownerFile(lock));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  rmdirSync(lock);
}

/** Make the lock and publish our owner token into it. False when the acquisition was lost (someone
 *  else's lock, or the directory removed under us): nothing of anyone else's is deleted. */
function tryAcquire(path: string, lock: string, token: string, opts: ServerSecretOptions): boolean {
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    opts.afterLockMade?.();
    return publishExclusive(tempPath(path), ownerFile(lock), JSON.stringify(ownerRecord(token)));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    try {
      rmdirSync(lock); // empty only: never someone else's lock
    } catch {
      // an ownerless lock is reaped once stale
    }
    throw e;
  }
}

/** Take over the lock of a holder judged dead. Only the waiter that creates the ticket named for the
 *  holder's unique token may remove its owner, so a lock re-made at the same path since we judged
 *  cannot be removed by mistake: we re-read the owner under the ticket first. */
function takeOver(lock: string, dead: Holder): boolean {
  const ticket = `${lock}.takeover.${dead.token}`;
  try {
    closeSync(openSync(ticket, "wx", 0o600));
  } catch {
    return false; // another waiter is on it (or died on it: the deadline error names the ticket)
  }
  try {
    if (parseHolder(readSmall(ownerFile(lock)))?.token !== dead.token) return false;
    unlinkSync(ownerFile(lock));
    rmdirSync(lock);
    process.stderr.write(`[server-secret] removed the repair lock of dead process ${dead.pid}\n`);
    return true;
  } catch {
    return false;
  } finally {
    removeTemp(ticket);
  }
}

/** Free the lock if nobody owns it (stale) or its holder is dead. True when it was removed. */
function breakLock(lock: string, staleMs: number, opts: ServerSecretOptions): boolean {
  const text = readSmall(ownerFile(lock));
  if (text === undefined) {
    if (!lockIsStale(lock, staleMs)) return false;
    try {
      rmdirSync(lock); // empty only: an owner that just appeared keeps it
      return true;
    } catch {
      return false;
    }
  }
  const holder = parseHolder(text);
  if (holder === undefined || !holderIsDead(holder)) return false;
  opts.beforeTakeOver?.();
  return takeOver(lock, holder);
}

function holderText(lock: string): string {
  const text = readSmall(ownerFile(lock));
  const h = parseHolder(text);
  if (h) return `process ${h.pid} on host ${h.scope.split("|")[0]}`;
  return text === undefined ? "no owner" : "an owner this version cannot read";
}

/** Take the repair lock and return its token, or the key a racing repairer finished while we
 *  waited. Past `waitMs` it fails closed, naming the lock and its holder. */
function acquireRepairLock(
  path: string,
  lock: string,
  opts: ServerSecretOptions,
): { token: string } | { key: string } {
  const staleMs = opts.staleMs ?? REPAIR_LOCK_STALE_MS;
  const waitMs = opts.waitMs ?? REPAIR_LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
  for (;;) {
    if (tryAcquire(path, lock, token, opts)) return { token };
    try {
      return { key: readValidated(path) };
    } catch {
      // still corrupt (or briefly unreadable): keep waiting
    }
    const broke = breakLock(lock, staleMs, opts);
    if (Date.now() > deadline) {
      throw new KeyFileError(
        `timed out after ${waitMs}ms waiting for the repair lock ${lock} while repairing ${path}; ` +
          `it is held by ${holderText(lock)}, which this process cannot show to be dead (a live ` +
          "holder is never taken over). Stop every obsidian-tc process that shares this cacheDir, " +
          `then delete ${lock} (a directory) and any ${lock}.takeover.* files, and start again`,
      );
    }
    if (!broke) sleep(10);
  }
}

/** Settle the key while holding the lock: publish one if the file is absent, or repair a corrupt
 *  one. `undefined` means the lock was lost or the file changed under us, and the caller must take
 *  the lock again. A valid file is never replaced: the corrupt one is moved aside and our key is
 *  linked in with no-replace, so a late repairer finds the file already valid or loses to whoever
 *  linked first, and everyone adopts the file's bytes. */
function settleHeld(
  path: string,
  lock: string,
  token: string,
  opts: ServerSecretOptions,
): string | undefined {
  if (!ownsLock(lock, token)) return undefined;
  try {
    return readValidated(path); // settled between our read and taking the lock
  } catch (e) {
    if (isMissing(e)) {
      publishNew(path, newSecret());
      return readIfPresent(path);
    }
    if (!isCorrupt(e)) throw e;
  }
  opts.beforeRepair?.();
  const tmp = tempPath(path);
  const aside = `${tmp}.aside`;
  try {
    createKeyFile(tmp, newSecret());
    if (!ownsLock(lock, token)) return undefined;
    // Nobody can have taken the lock from a live holder, but re-read the file right before the
    // move anyway: it must still be the corrupt one, never a valid key.
    try {
      return readValidated(path);
    } catch (e) {
      if (isMissing(e)) return undefined;
      if (!isCorrupt(e)) throw e;
    }
    opts.beforeMoveAside?.();
    renameOverBusy(path, aside);
    opts.inMoveGap?.();
    let moved: string | undefined;
    try {
      moved = readValidated(aside);
    } catch {
      // what we moved is the corrupt file, as expected
    }
    try {
      linkSync(moved !== undefined ? aside : tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    return readIfPresent(path);
  } finally {
    removeTemp(tmp);
    removeTemp(aside);
  }
}

/** Run `settleHeld` under the repair lock until it yields a key (bounded: each lost round backs off). */
function settleUnderLock(path: string, opts: ServerSecretOptions): string {
  const lock = `${path}.repair-lock`;
  for (let round = 0; round < 50; round++) {
    const got = acquireRepairLock(path, lock, opts);
    if ("key" in got) return got.key;
    try {
      const key = settleHeld(path, lock, got.token, opts);
      if (key !== undefined) return key;
    } finally {
      if (ownsLock(lock, got.token)) {
        try {
          removeLock(lock);
        } catch {
          // best effort: a leftover lock names a dead holder and is taken over
        }
      }
    }
    sleep(10);
  }
  throw new KeyFileError(`${path} kept changing while it was being settled; try again`);
}

/** The stable per-server secret, created on first use through the same descriptor-based
 *  0700-directory/0600-file helpers as locally generated JWT signing keys. Processes sharing a
 *  `cacheDir` share it: the no-replace publish means a racing creator adopts the winner's key, and
 *  a corrupt file is repaired by one process under a lock while the others adopt its key. */
export function serverSecret(cacheDir: string, opts: ServerSecretOptions = {}): string {
  const path = secretPath(cacheDir);
  ensureKeysDir(join(cacheDir, SECRET_DIR), { create: true });
  try {
    return readValidated(path);
  } catch (e) {
    if (isMissing(e) || !existsNoFollow(path)) return settleUnderLock(path, opts);
    if (isCorrupt(e)) {
      process.stderr.write(`[server-secret] ${path} is corrupt; regenerating it atomically\n`);
      return settleUnderLock(path, opts);
    }
    throw e;
  }
}
