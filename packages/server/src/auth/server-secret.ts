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
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  /** A repair lock untouched this long is treated as left by a dead holder. */
  staleMs?: number;
  /** How long to wait on another repairer before giving up with an error. */
  waitMs?: number;
  /** Runs after the repairer has judged the file corrupt and just before it replaces it (a test stalls a holder here). */
  beforeRepair?: () => void;
}

const secretPath = (cacheDir: string): string => join(cacheDir, SECRET_DIR, SECRET_FILE);

const isCorrupt = (e: unknown): boolean =>
  e instanceof KeyFileError && / is (?:empty|corrupt)/.test(e.message);

const readValidated = (path: string): string => {
  let secret: string;
  try {
    secret = readKeyFile(path);
  } catch (e) {
    // A key others could read must be treated as disclosed: tightening the mode would adopt it
    // again, so the advice is to delete it (a new one is generated), not to chmod it.
    if (e instanceof KeyFileError && / readable by group\/other; /.test(e.message)) {
      throw new KeyFileError(
        `${e.message}. Do not just chmod it: it was readable by others, so treat it as disclosed. ` +
          "Delete the file to regenerate it on the next start (pending confirmations are refused " +
          "once, and generated wiki pages read as edited, then regenerate)",
        e,
      );
    }
    throw e;
  }
  if (!KEY_FORMAT.test(secret))
    throw new KeyFileError(`${path} is corrupt (expected one complete 32-byte base64url key)`);
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
  try {
    return readValidated(path);
  } catch (e) {
    if (isMissing(e)) return undefined; // vanished while a repairer had it moved aside
    throw e;
  }
}

/** Publish a fully written and fsynced temporary key with an atomic, no-replace hard link. */
function publishNew(path: string, secret: string): void {
  const tmp = tempPath(path);
  try {
    createKeyFile(tmp, secret);
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  } finally {
    removeTemp(tmp);
  }
}

/** The read failed because there was no file: a repairer has the corrupt one moved aside and has
 *  not linked its key in yet. Decided from the failed open itself, not from a second look at the
 *  path, which can already show the repaired file. */
const isMissing = (e: unknown): boolean =>
  e instanceof KeyFileError && (e.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Read the key, publishing one first if the file is missing (no-replace, so whichever key is
 *  linked first wins and everyone reads it back). Retries a bounded number of times, because the
 *  file can vanish again while a repairer moves a corrupt one aside. */
function readOrPublish(path: string): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return readValidated(path);
    } catch (e) {
      if (!isMissing(e) || attempt >= 20) throw e;
      publishNew(path, newSecret());
    }
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

// The repair lock is a directory holding an `owner` token (mkdir is atomic). The lock only keeps
// repairers from queueing on each other; it is NOT what makes the repair safe. A holder can stall
// past the stale threshold while alive and have its lock taken over, so every step re-checks that
// it still owns the lock, never replaces a file with its own key (it moves the corrupt file aside
// and links its key in with no-replace), and every caller returns what the file holds afterwards.
const ownerFile = (lock: string): string => join(lock, "owner");

const ownsLock = (lock: string, token: string): boolean => {
  try {
    return readFileSync(ownerFile(lock), "utf8") === token;
  } catch {
    return false;
  }
};

const lockIsStale = (lock: string, staleMs: number): boolean => {
  try {
    return Date.now() - statSync(lock).mtimeMs > staleMs;
  } catch {
    return false;
  }
};

/** Remove a lock this process does not (or no longer) holds. Throws when it cannot (a non-empty
 *  directory, a symlink): the caller then backs off instead of retrying hot. */
function removeLock(lock: string): void {
  try {
    unlinkSync(ownerFile(lock));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  rmdirSync(lock);
}

/** Take the repair lock and return its token, or the key a racing repairer finished while we
 *  waited. A lock left by a holder that died is broken once stale; one that cannot be broken, or a
 *  holder that never finishes, fails with a clear error once `waitMs` has passed. */
function acquireRepairLock(
  path: string,
  lock: string,
  opts: ServerSecretOptions,
): { token: string } | { key: string } {
  const staleMs = opts.staleMs ?? REPAIR_LOCK_STALE_MS;
  const deadline = Date.now() + (opts.waitMs ?? REPAIR_LOCK_WAIT_MS);
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
      try {
        writeFileSync(ownerFile(lock), token, { mode: 0o600 });
      } catch (e) {
        try {
          removeLock(lock);
        } catch {
          // a lock with no owner goes stale and is broken by the next start
        }
        throw e;
      }
      return { token };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      return { key: readValidated(path) };
    } catch {
      // still corrupt (or briefly unreadable): keep waiting
    }
    let broke = false;
    if (lockIsStale(lock, staleMs)) {
      try {
        removeLock(lock);
        broke = true;
      } catch {
        // fall through to the deadline and backoff below; never retry the removal hot
      }
    }
    if (broke) continue;
    if (Date.now() > deadline) {
      throw new KeyFileError(
        `timed out waiting for the repair lock ${lock} while repairing ${path}. If no other ` +
          `obsidian-tc process is running, delete ${lock} (a directory) and start again`,
      );
    }
    sleep(10);
  }
}

/** Repair a corrupt file while holding the lock; `undefined` means the lock was lost and the
 *  caller must take it again. A valid file is never replaced: the corrupt one is moved aside and
 *  our key is linked in with no-replace, so a repairer that is late loses to whoever linked first
 *  (or finds the file already valid) and everyone adopts the file's bytes. */
function repairHeld(
  path: string,
  lock: string,
  token: string,
  opts: ServerSecretOptions,
): string | undefined {
  if (!ownsLock(lock, token)) return undefined;
  try {
    return readValidated(path); // repaired between our read and taking the lock
  } catch (e) {
    if (isMissing(e) || !existsNoFollow(path)) return readOrPublish(path);
    if (!isCorrupt(e)) throw e;
  }
  opts.beforeRepair?.();
  const tmp = tempPath(path);
  const aside = `${tmp}.aside`;
  try {
    createKeyFile(tmp, newSecret());
    if (!ownsLock(lock, token)) return undefined;
    renameOverBusy(path, aside);
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
    return readOrPublish(path);
  } finally {
    removeTemp(tmp);
    removeTemp(aside);
  }
}

function repairCorrupt(path: string, opts: ServerSecretOptions): string {
  const lock = `${path}.repair-lock`;
  for (;;) {
    const got = acquireRepairLock(path, lock, opts);
    if ("key" in got) return got.key;
    try {
      const key = repairHeld(path, lock, got.token, opts);
      if (key !== undefined) return key;
    } finally {
      if (ownsLock(lock, got.token)) {
        try {
          removeLock(lock);
        } catch {
          // best effort: a leftover lock goes stale
        }
      }
    }
  }
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
    if (isMissing(e) || !existsNoFollow(path)) return readOrPublish(path);
    if (isCorrupt(e)) {
      process.stderr.write(`[server-secret] ${path} is corrupt; regenerating it atomically\n`);
      return repairCorrupt(path, opts);
    }
    throw e;
  }
}
