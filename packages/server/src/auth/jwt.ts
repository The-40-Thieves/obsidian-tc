import { createLocalJWKSet, jwtVerify } from "jose";

export interface JwtIdentity {
  /** The token subject (`sub`), or null when absent. */
  caller: string | null;
  /** Scopes granted by the token, from a `scopes` array or space-delimited `scope`. */
  scopes: Set<string>;
  /** Optional vault binding (`vault` claim). When present, the HTTP edge binds the caller to
   *  this vault and dispatch rejects any tool call naming a different vault (THE-267). */
  vault?: string;
}

/**
 * Verify an HS256 JWT and extract caller identity + granted scopes. Throws on a bad
 * signature, a missing or elapsed `exp`, a token older than `maxAgeSeconds` (when it
 * carries `iat`), or a non-HS256 algorithm (the caller maps that to 401).
 * Authentication only: authorization (scope/ACL enforcement) stays in dispatch.
 */
export async function verifyJwt(
  token: string,
  secret: string,
  opts: { maxAgeSeconds?: number; audience?: string | string[]; issuer?: string } = {},
): Promise<JwtIdentity> {
  if (!secret) throw new Error("empty secret not allowed");

  // requiredClaims:["exp"] closes the "token without exp never expires" gap — jose only
  // enforces expiry when exp is present, so demand it. maxAgeSeconds (from auth.tokenTtlSeconds)
  // additionally caps token age, but only when the token carries iat, so existing exp-only
  // tokens keep working. THE-456: audience/issuer are enforced by jose only when configured
  // (undefined = not checked), so local self-issued tokens are unaffected.
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    requiredClaims: ["exp"],
    ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
    ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
  });
  return identityFrom(payload, opts.maxAgeSeconds);
}

/** THE-297: default asymmetric allowlist. HS256 is deliberately NOT here — it verifies only
 *  against the shared secret, never a JWKS (alg-confusion safety). */
export const DEFAULT_ASYMMETRIC_ALGS = ["RS256", "ES256", "EdDSA"];

/**
 * Verify an asymmetric JWT (RS256/ES256/EdDSA) against a local JWKS document. jose selects the
 * key by the token's `kid` header (falling back to alg matching for single-key sets), which is
 * the rotation story: publish old + new keys together, retire the old one later. Same exp /
 * max-age posture as the HS256 path.
 */
export async function verifyJwtJwks(
  token: string,
  jwks: Record<string, unknown>,
  opts: {
    maxAgeSeconds?: number;
    algorithms?: string[];
    audience?: string | string[];
    issuer?: string;
  } = {},
): Promise<JwtIdentity> {
  const keySet = createLocalJWKSet(jwks as unknown as Parameters<typeof createLocalJWKSet>[0]);
  // THE-456: on the asymmetric/JWKS path a shared external issuer can mint tokens for many
  // resources, so audience binding is what stops a token issued for another service being replayed
  // here (confused-deputy). Enforced by jose only when configured.
  const { payload } = await jwtVerify(token, keySet, {
    algorithms: opts.algorithms ?? DEFAULT_ASYMMETRIC_ALGS,
    requiredClaims: ["exp"],
    ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
    ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
  });
  return identityFrom(payload, opts.maxAgeSeconds);
}

function identityFrom(
  payload: Record<string, unknown>,
  maxAgeSeconds: number | undefined,
): JwtIdentity {
  const tooOld =
    maxAgeSeconds !== undefined &&
    typeof payload.iat === "number" &&
    Math.floor(Date.now() / 1000) - payload.iat > maxAgeSeconds;
  if (tooOld) throw new Error("token exceeds the configured maximum age");
  return {
    caller: typeof payload.sub === "string" ? payload.sub : null,
    scopes: extractScopes(payload),
    vault: typeof payload.vault === "string" ? payload.vault : undefined,
  };
}

function extractScopes(payload: Record<string, unknown>): Set<string> {
  if (Array.isArray(payload.scopes)) {
    return new Set(payload.scopes.filter((s): s is string => typeof s === "string"));
  }
  if (typeof payload.scope === "string") {
    return new Set(payload.scope.split(/\s+/).filter(Boolean));
  }
  return new Set();
}
