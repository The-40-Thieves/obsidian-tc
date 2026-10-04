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
import { linkSync, mkdirSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
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
  return readValidated(path);
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

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const lockIsStale = (lock: string): boolean => {
  try {
    return Date.now() - statSync(lock).mtimeMs > REPAIR_LOCK_STALE_MS;
  } catch {
    return false;
  }
};

/** Take the repair lock (a directory: `mkdir` is atomic). Returns a key instead when a racing
 *  repairer finished while we waited; a lock left by a holder that died is broken once stale. */
function acquireRepairLock(path: string, lock: string): string | undefined {
  const deadline = Date.now() + REPAIR_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return undefined;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      return readValidated(path);
    } catch {
      // still corrupt (or briefly unreadable): keep waiting
    }
    if (lockIsStale(lock)) {
      try {
        rmdirSync(lock);
      } catch {
        // another waiter broke it first
      }
      continue;
    }
    if (Date.now() > deadline) throw new KeyFileError(`timed out waiting to repair ${path}`);
    sleep(10);
  }
}

/** `rename` over `path`, riding out the brief sharing violation Windows raises while a waiting
 *  process has the corrupt file open for its validity poll. Bounded: a lock that never clears
 *  surfaces as the original error, not a hang. */
function renameOverBusy(from: string, path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 100 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      sleep(10);
    }
  }
}

/** Replace a corrupt file with a fully written and fsynced temporary key, under a lock, so exactly
 *  one process repairs it and every other adopts that key. An unconditional rename let N racing
 *  processes each return their own key while only the last one's survived in the file. */
function repairCorrupt(path: string): string {
  const lock = `${path}.repair-lock`;
  const adopted = acquireRepairLock(path, lock);
  if (adopted !== undefined) return adopted;
  try {
    try {
      return readValidated(path); // repaired between our read and taking the lock
    } catch (e) {
      if (!existsNoFollow(path)) {
        publishNew(path, newSecret());
        return readValidated(path);
      }
      if (!isCorrupt(e)) throw e;
    }
    const tmp = tempPath(path);
    try {
      createKeyFile(tmp, newSecret());
      renameOverBusy(tmp, path);
    } finally {
      removeTemp(tmp);
    }
    return readValidated(path);
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // best effort: a leftover lock goes stale
    }
  }
}

/** The stable per-server secret, created on first use through the same descriptor-based
 *  0700-directory/0600-file helpers as locally generated JWT signing keys. Processes sharing a
 *  `cacheDir` share it: the no-replace publish means a racing creator adopts the winner's key, and
 *  a corrupt file is repaired by one process under a lock while the others adopt its key. */
export function serverSecret(cacheDir: string): string {
  const path = secretPath(cacheDir);
  ensureKeysDir(join(cacheDir, SECRET_DIR), { create: true });
  try {
    return readValidated(path);
  } catch (e) {
    if (!existsNoFollow(path)) {
      publishNew(path, newSecret());
      return readValidated(path);
    }
    if (isCorrupt(e)) {
      process.stderr.write(`[server-secret] ${path} is corrupt; regenerating it atomically\n`);
      return repairCorrupt(path);
    }
    throw e;
  }
}
