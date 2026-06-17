import { jwtVerify } from "jose";

export interface JwtIdentity {
  /** The token subject (`sub`), or null when absent. */
  caller: string | null;
  /** Scopes granted by the token, from a `scopes` array or space-delimited `scope`. */
  scopes: Set<string>;
}

/**
 * Verify an HS256 JWT and extract caller identity + granted scopes. Throws on a
 * bad signature, expiry, or a non-HS256 algorithm (the caller maps that to 401).
 * Authentication only: authorization (scope/ACL enforcement) stays in dispatch.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtIdentity> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
  });
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
