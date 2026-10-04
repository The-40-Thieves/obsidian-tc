// The seal on a generated wiki page (see wiki-generated.ts): `generated_by: obsidian-tc` marks the
// page, and `generated_hash` is a keyed HMAC of the whole file with that one line blanked. The key
// is server-local state, not vault content, so replacing both the file and its hash cannot forge a
// server-authored page. Old unkeyed SHA seals are recognised only for one-time full regeneration;
// their body and log cursor are never trusted or appended to.
import { createHash, createHmac } from "node:crypto";
import { readServerSecret, serverSecret } from "../../../auth/server-secret";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MARKER = /^generated_by: obsidian-tc[ \t]*$/m;
const HASH_LINE = /^generated_hash: ?.*$/m;
const HMAC_PREFIX = "hmac-sha256:";

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

/** The generated-page HMAC key is the per-server secret itself (auth/server-secret.ts), used raw as
 *  the HMAC key under this file's own message prefix, so seals minted before that module was
 *  extracted verify unchanged. */
export const getOrCreateWikiSealKey = serverSecret;
/** Read the generated-page key without creating or repairing any state. */
export const readWikiSealKey = readServerSecret;

/** Whether a note's frontmatter says the server generated it (sealed or not). The link scans skip
 *  such a page as a link SOURCE: an index that links every page must not rescue an orphan. */
export function isGeneratedPage(raw: string): boolean {
  const fm = FRONTMATTER.exec(raw)?.[1];
  return fm !== undefined && MARKER.test(fm);
}
