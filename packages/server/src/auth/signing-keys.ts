// Algorithms a registry signing key may use, and the JWK handling for the asymmetric ones.
//
// The registry row's `alg` is the ONLY thing that decides how a key verifies. This module keeps that
// decision small and closed: three algorithms, one JWK shape each, and every key that crosses a
// boundary (generated, read back from a 0600 file, stored as `public_jwk`, published in the JWKS) is
// re-checked against the algorithm it claims to be. A JWK that does not fit its algorithm is refused,
// never coerced.
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

export const KEY_ALGS = ["HS256", "ES256", "EdDSA"] as const;
export type KeyAlg = (typeof KEY_ALGS)[number];
export type AsymmetricAlg = Exclude<KeyAlg, "HS256">;

/** Longest rotation grace window accepted anywhere (config, `--grace`, `rotateKey`): 7 days. A
 *  retiring key keeps verifying every token it ever signed, so an unbounded window is a key that
 *  is never really rotated. Mirrored by the `auth.rotationGraceSeconds` schema bound. */
export const MAX_ROTATION_GRACE_SECONDS = 604_800;

/** What a registry key signs: `mint` is the operator's hand-minted tokens (today's behaviour), `as`
 *  the bundled authorization server's access tokens. One ACTIVE key per purpose; the verifier picks
 *  its rules from the purpose of the row a token's `kid` names. */
export const KEY_PURPOSES = ["mint", "as"] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];
export const isKeyPurpose = (p: unknown): p is KeyPurpose =>
  (KEY_PURPOSES as readonly unknown[]).includes(p);

/** Default `auth.as.accessTokenSeconds`. */
export const DEFAULT_AS_ACCESS_TOKEN_SECONDS = 1800;
/** Clock skew allowed on top of an access token's lifetime when sizing an `as` rotation window. */
export const AS_KEY_SKEW_SECONDS = 60;
/** The shortest grace window that lets every access token an `as` key signed expire before the key
 *  stops verifying: its lifetime plus skew. Rotating faster would kill live access tokens. */
export const asGraceFloorSeconds = (
  accessTokenSeconds: number = DEFAULT_AS_ACCESS_TOKEN_SECONDS,
): number => {
  // NaN compares false against every grace window and Infinity or a non-positive lifetime sizes the
  // floor to something no window can meet or to nothing: refuse rather than compute.
  if (!Number.isFinite(accessTokenSeconds) || accessTokenSeconds <= 0) {
    throw new Error(
      `access-token lifetime must be a positive, finite number of seconds, got ${String(accessTokenSeconds)}`,
    );
  }
  return accessTokenSeconds + AS_KEY_SKEW_SECONDS;
};

export const isKeyAlg = (alg: string): alg is KeyAlg =>
  (KEY_ALGS as readonly string[]).includes(alg);
export const isAsymmetricAlg = (alg: string): alg is AsymmetricAlg =>
  alg === "ES256" || alg === "EdDSA";

/** The public members a JWKS entry may carry from the key itself. Everything else, in particular
 *  `d`, is dropped, so publishing cannot leak private material even from a malformed stored row. */
export interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  y?: string;
}
export type PublishedJwk = PublicJwk & { kid: string; alg: AsymmetricAlg; use: "sig" };

export interface GeneratedSigningKey {
  alg: AsymmetricAlg;
  /** Written to the 0600 key file, never to the database. */
  privateJwk: JWK;
  publicJwk: PublicJwk;
  /** RFC 7638 thumbprint of the public key: the `kid` of an `as` key. */
  thumbprint: string;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Does `jwk` have the key type and curve `alg` requires? */
function fits(alg: AsymmetricAlg, jwk: JWK): boolean {
  if (alg === "ES256")
    return jwk.kty === "EC" && jwk.crv === "P-256" && isStr(jwk.x) && isStr(jwk.y);
  return jwk.kty === "OKP" && jwk.crv === "Ed25519" && isStr(jwk.x);
}

/** The public half of `jwk`, restricted to public members, or an Error when it does not fit `alg`. */
export function publicJwkOf(alg: AsymmetricAlg, jwk: JWK): PublicJwk {
  if (!fits(alg, jwk)) throw new Error(`key does not fit ${alg}`);
  return {
    kty: jwk.kty as string,
    crv: jwk.crv as string,
    x: jwk.x as string,
    ...(alg === "ES256" ? { y: jwk.y } : {}),
  };
}

/** Parse the text of an asymmetric key file into its private JWK, or throw. */
export function parsePrivateJwk(alg: AsymmetricAlg, text: string): JWK {
  let jwk: JWK;
  try {
    jwk = JSON.parse(text) as JWK;
  } catch (e) {
    throw new Error("signing key file is not a JWK", { cause: e });
  }
  if (jwk === null || typeof jwk !== "object" || !fits(alg, jwk) || !isStr(jwk.d)) {
    throw new Error(`signing key file is not a private ${alg} key`);
  }
  return jwk;
}

export async function generateSigningKey(alg: AsymmetricAlg): Promise<GeneratedSigningKey> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = publicJwkOf(alg, await exportJWK(publicKey));
  return { alg, privateJwk, publicJwk, thumbprint: await calculateJwkThumbprint(publicJwk) };
}

/** The signing key for a token: the private JWK from a key file, imported for `alg`. */
export async function importSigningKey(alg: AsymmetricAlg, keyFileText: string) {
  return importJWK(parsePrivateJwk(alg, keyFileText), alg);
}

// Verification keys are public and immutable per JWK text, so the imported key is reused across
// requests. Bounded: a registry holds a handful of keys, and the map is cleared rather than grown
// if it ever does not.
const verificationKeys = new Map<string, Awaited<ReturnType<typeof importJWK>>>();
const VERIFICATION_KEY_CACHE_MAX = 64;

export async function importVerificationKey(alg: AsymmetricAlg, publicJwk: PublicJwk) {
  const jwk = publicJwkOf(alg, publicJwk);
  const cacheKey = `${alg}|${JSON.stringify(jwk)}`;
  const hit = verificationKeys.get(cacheKey);
  if (hit !== undefined) return hit;
  const key = await importJWK(jwk, alg);
  if (verificationKeys.size >= VERIFICATION_KEY_CACHE_MAX) verificationKeys.clear();
  verificationKeys.set(cacheKey, key);
  return key;
}
