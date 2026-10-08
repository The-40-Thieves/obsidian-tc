// The response that created a refresh token, kept so a retry of its parent inside the one-step window
// is answered with the SAME access token and successor instead of a new bearer per retry (design v2
// section 4.6, "As built (S6)"). It is sealed, because it holds a bearer credential: AES-256-GCM under
// a key HKDF-derived from the per-server secret (never the secret itself), with the parent's hash as
// the associated data so a seal copied onto another row does not open. Only the server that holds the
// secret can read it; replacing the secret makes every seal unreadable, which is the intended end.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const KEY_INFO = "obsidian-tc/as-refresh-replay/v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** What a retry needs to answer exactly as the first request did. */
export interface ReplayedResponse {
  token: string;
  jti: string;
  /** The access token's `exp`, NumericDate seconds. */
  exp: number;
  scope: string;
  vault: string | null;
}

const keyOf = (secret: string): Buffer => Buffer.from(hkdfSync("sha256", secret, "", KEY_INFO, 32));

/**
 * A non-secret fingerprint of the server secret: a refresh-token row records the one that minted it, and
 * is honoured only while it is still the server's. One-way (HMAC under a fixed label), truncated.
 */
export const secretGeneration = (secret: string): string =>
  createHmac("sha256", secret).update("as-refresh-generation").digest("hex").slice(0, 32);

export function sealResponse(secret: string, parentHash: string, r: ReplayedResponse): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  cipher.setAAD(Buffer.from(parentHash));
  const body = Buffer.concat([cipher.update(JSON.stringify(r), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** The stored response, or undefined when it is absent, altered, from another parent or another secret. */
export function openResponse(
  secret: string,
  parentHash: string,
  sealed: string | null,
): ReplayedResponse | undefined {
  if (sealed === null) return undefined;
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(parentHash));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const text = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
    const r = JSON.parse(text) as Partial<ReplayedResponse>;
    return typeof r.token === "string" &&
      typeof r.jti === "string" &&
      typeof r.exp === "number" &&
      typeof r.scope === "string" &&
      (r.vault === null || typeof r.vault === "string")
      ? (r as ReplayedResponse)
      : undefined;
  } catch {
    return undefined;
  }
}
