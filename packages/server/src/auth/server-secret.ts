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
import { linkSync, renameSync, unlinkSync } from "node:fs";
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

const secretPath = (cacheDir: string): string => join(cacheDir, SECRET_DIR, SECRET_FILE);

const readValidated = (path: string): string => {
  const secret = readKeyFile(path);
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

/** Read the server secret without creating or repairing any state. */
export function readServerSecret(cacheDir: string): string | undefined {
  const path = secretPath(cacheDir);
  if (!existsNoFollow(path)) return undefined;
  return readValidated(path);
}

/** Publish a fully written and fsynced temporary key with an atomic, no-replace hard link. */
function publishNew(path: string, secret: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
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

/** Atomically replace a corrupt file with a fully written and fsynced temporary key. */
function replaceCorrupt(path: string, secret: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    createKeyFile(tmp, secret);
    renameSync(tmp, path);
  } finally {
    removeTemp(tmp);
  }
}

/** The stable per-server secret, created on first use through the same descriptor-based
 *  0700-directory/0600-file helpers as locally generated JWT signing keys. Processes sharing a
 *  `cacheDir` share it: the no-replace publish means a racing creator adopts the winner's key. */
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
    if (e instanceof KeyFileError && / is (?:empty|corrupt)/.test(e.message)) {
      process.stderr.write(`[server-secret] ${path} is corrupt; regenerating it atomically\n`);
      replaceCorrupt(path, newSecret());
      return readValidated(path);
    }
    throw e;
  }
}
