import { jwtVerify } from "jose";

export interface JwtIdentity {
  /** The token subject (`sub`), or null when absent. */
  caller: string | null;
  /** Scopes granted by the token, from a `scopes` array or space-delimited `scope`. */
  scopes: Set<string>;
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
  opts: { maxAgeSeconds?: number } = {},
): Promise<JwtIdentity> {
  if (!secret) throw new Error("empty secret not allowed");

  // requiredClaims:["exp"] closes the "token without exp never expires" gap — jose only
  // enforces expiry when exp is present, so demand it. maxAgeSeconds (from auth.tokenTtlSeconds)
  // additionally caps token age, but only when the token carries iat, so existing exp-only
  // tokens keep working.
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    requiredClaims: ["exp"],
  });
  const tooOld =
    opts.maxAgeSeconds !== undefined &&
    typeof payload.iat === "number" &&
    Math.floor(Date.now() / 1000) - payload.iat > opts.maxAgeSeconds;
  if (tooOld) throw new Error("token exceeds the configured maximum age");
  return {
    caller: typeof payload.sub === "string" ? payload.sub : null,
    scopes: extractScopes(payload),
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
