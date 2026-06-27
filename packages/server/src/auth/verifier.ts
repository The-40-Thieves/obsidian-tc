import { type JwtIdentity, verifyJwt } from "./jwt";

/** Result of verifying a bearer token: caller identity + granted scopes. */
export type VerifiedIdentity = JwtIdentity;

/**
 * Pluggable bearer-token verifier seam. The HTTP edge authenticates by calling
 * `verify(token)`; the default implementation verifies an HS256 JWT (jose). An OAuth 2.1
 * bearer / introspection verifier can be dropped in here without touching the transport —
 * the floor for folding the knowledge-mcp-server OAuth surface onto obsidian-tc's jose auth.
 *
 * THE-233 W-AUTH probe finding: KMS's full OAuth 2.1 Authorization Server + DCR (consent,
 * /register, token issuance via mcp-oauth-server) was load-bearing for the *cloud* service
 * (claude.ai's connector registered dynamically). The converged obsidian-tc has no AS or
 * DCR client of its own yet, so per the locked decision note this seam is the floor; a full
 * AS port (on Hono + jose, dropping express + mcp-oauth-server) is a follow-up gated on the
 * converged product directly hosting a remote DCR client.
 */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

/** Default verifier: HS256 JWT via jose, capping token age at `maxAgeSeconds` when present. */
export function createJwtVerifier(
  secret: string,
  opts: { maxAgeSeconds?: number } = {},
): TokenVerifier {
  return {
    verify: (token) => verifyJwt(token, secret, opts),
  };
}
