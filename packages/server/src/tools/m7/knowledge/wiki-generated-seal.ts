// The seal on a generated wiki page (see wiki-generated.ts): `generated_by: obsidian-tc` marks the
// page, and `generated_hash` is a keyed HMAC of the whole file with that one line blanked. The key
// is server-local state, not vault content, so replacing both the file and its hash cannot forge a
// server-authored page. Old unkeyed SHA seals are recognised only for one-time full regeneration;
// their body and log cursor are never trusted or appended to.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { linkSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  createKeyFile,
  ensureKeysDir,
  existsNoFollow,
  KeyFileError,
  readKeyFile,
} from "../../../auth/key-files";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MARKER = /^generated_by: obsidian-tc[ \t]*$/m;
const HASH_LINE = /^generated_hash: ?.*$/m;
const HMAC_PREFIX = "hmac-sha256:";
const SECRET_DIR = "server-secrets";
const SECRET_FILE = "wiki-generated.key";
const KEY_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export interface GeneratedSealIdentity {
  vaultId: string;
  path: string;
}

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const hmac = (text: string, key: string, identity: GeneratedSealIdentity): string =>
  createHmac("sha256", key)
    .update(
      JSON.stringify(["obsidian-tc/wiki-generated/v1", identity.vaultId, identity.path, text]),
      "utf8",
    )
    .digest("hex");

/** `text` with its `generated_hash:` line emptied: what the hash is computed over. */
export const blankHash = (text: string): string =>
  text.replace(HASH_LINE, () => "generated_hash: ");

/** `text` (carrying a blank `generated_hash:` line) with the hash filled in. */
export const seal = (text: string, key: string, identity: GeneratedSealIdentity): string =>
  text.replace(
    HASH_LINE,
    () => `generated_hash: ${HMAC_PREFIX}${hmac(blankHash(text), key, identity)}`,
  );

export type GeneratedState = "ours" | "legacy" | "edited" | "foreign";

/** Whether `raw` is a page we generated and nobody changed since. */
export function inspectGenerated(
  raw: string,
  key: string,
  identity: GeneratedSealIdentity,
): GeneratedState {
  const fm = FRONTMATTER.exec(raw)?.[1];
  if (fm === undefined || !MARKER.test(fm)) return "foreign";
  const keyed = /^generated_hash: ?hmac-sha256:([0-9a-f]{64})[ \t]*$/m.exec(fm)?.[1];
  if (keyed !== undefined) {
    const storedVault = jsonFrontmatterString(fm, "generated_vault");
    const storedPath = jsonFrontmatterString(fm, "generated_path");
    if (storedVault !== identity.vaultId || storedPath !== identity.path) return "foreign";
    return keyed === hmac(blankHash(raw), key, identity) ? "ours" : "edited";
  }
  const legacy = /^generated_hash: ?([0-9a-f]{64})[ \t]*$/m.exec(fm)?.[1];
  return legacy !== undefined && legacy === sha(blankHash(raw)) ? "legacy" : "edited";
}

function jsonFrontmatterString(frontmatter: string, key: string): string | undefined {
  const raw = new RegExp(`^${key}: (.+)$`, "m").exec(frontmatter)?.[1];
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

const keyPath = (cacheDir: string): string => join(cacheDir, SECRET_DIR, SECRET_FILE);

const readValidatedKey = (path: string): string => {
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

/** Read the generated-page key without creating or repairing any state. */
export function readWikiSealKey(cacheDir: string): string | undefined {
  const path = keyPath(cacheDir);
  if (!existsNoFollow(path)) return undefined;
  return readValidatedKey(path);
}

/** Publish a fully written and fsynced temporary key with an atomic, no-replace hard link. */
function publishNewKey(path: string, secret: string): void {
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
function replaceCorruptKey(path: string, secret: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    createKeyFile(tmp, secret);
    renameSync(tmp, path);
  } finally {
    removeTemp(tmp);
  }
}

/** The stable HMAC key for generated wiki pages. It is created on first use through the same
 * descriptor-based 0700-directory/0600-file helpers as locally generated JWT signing keys. */
export function getOrCreateWikiSealKey(cacheDir: string): string {
  const dir = join(cacheDir, SECRET_DIR);
  const path = keyPath(cacheDir);
  ensureKeysDir(dir, { create: true });
  try {
    return readValidatedKey(path);
  } catch (e) {
    if (!existsNoFollow(path)) {
      publishNewKey(path, randomBytes(32).toString("base64url"));
      return readValidatedKey(path);
    }
    if (e instanceof KeyFileError && / is (?:empty|corrupt)/.test(e.message)) {
      process.stderr.write(`[wiki-pages] ${path} is corrupt; regenerating it atomically\n`);
      replaceCorruptKey(path, randomBytes(32).toString("base64url"));
      return readValidatedKey(path);
    }
    throw e;
  }
}

/** Whether a note's frontmatter says the server generated it (sealed or not). The link scans skip
 *  such a page as a link SOURCE: an index that links every page must not rescue an orphan. */
export function isGeneratedPage(raw: string): boolean {
  const fm = FRONTMATTER.exec(raw)?.[1];
  return fm !== undefined && MARKER.test(fm);
}
