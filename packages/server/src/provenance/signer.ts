// EdDSA signing and verification for provenance records, backed by the auth registry's keys.
//
// Signing uses the ACTIVE registry key, and only when it is EdDSA: an HS256 key is a shared secret
// (anyone who can verify could forge), and the provenance contract is asymmetric. With no EdDSA
// active key a record is written UNSIGNED and `provenance verify` says so; nothing is ever signed
// with a weaker key to look complete.
//
// Verification needs only PUBLIC keys and accepts every registry key in any state. A rotated-out
// (`retiring` or `retired`) key stops signing new records and stops verifying bearer tokens, but
// the records it signed while active must stay verifiable for as long as they are kept.
import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import type { AuthKey, AuthRegistry } from "../auth/registry";
import { type PublicJwk, parsePrivateJwk, publicJwkOf } from "../auth/signing-keys";

export interface ProvenanceSigner {
  kid: string;
  /** base64url EdDSA signature over `message` (UTF-8). */
  sign(message: string): string;
}

/** Resolved per append, so a rotation is picked up by the very next record. */
export type SignerSource = () => ProvenanceSigner | undefined;

/** Resolves a kid to its public key, or undefined for a kid the registry has never held. */
export type KeyResolver = (kid: string) => PublicJwk | undefined;

export function registrySignerSource(
  registry: Pick<AuthRegistry, "signingKey">,
  onError?: (e: unknown) => void,
): SignerSource {
  // One entry: the imported key for the secret text last seen. The registry already re-reads the
  // key file on its own TTL, so this only avoids re-importing an unchanged key on every append.
  let cached: { secret: string; key: KeyObject } | undefined;
  return () => {
    try {
      const k = registry.signingKey();
      if (k.alg !== "EdDSA") return undefined;
      if (cached?.secret !== k.secret) {
        cached = {
          secret: k.secret,
          key: createPrivateKey({ key: parsePrivateJwk("EdDSA", k.secret), format: "jwk" }),
        };
      }
      const key = cached.key;
      return {
        kid: k.kid,
        sign: (message) => sign(null, Buffer.from(message, "utf8"), key).toString("base64url"),
      };
    } catch (e) {
      // A lost registry or an unreadable key file: the record is written unsigned and this is
      // reported, never swallowed — doctor shows the registry state on its own line.
      onError?.(e);
      return undefined;
    }
  };
}

/** Every EdDSA key the registry holds, whatever its state, by kid. */
export function registryKeyResolver(keys: readonly AuthKey[]): KeyResolver {
  const byKid = new Map<string, PublicJwk>();
  for (const k of keys) {
    if (k.alg === "EdDSA" && k.publicJwk !== null) byKid.set(k.kid, k.publicJwk);
  }
  return (kid) => byKid.get(kid);
}

/** True iff `sig` is a valid EdDSA signature of `message` under `jwk`. Never throws. */
export function verifyMessage(jwk: PublicJwk, message: string, sig: string): boolean {
  try {
    const key = createPublicKey({ key: publicJwkOf("EdDSA", jwk), format: "jwk" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}
