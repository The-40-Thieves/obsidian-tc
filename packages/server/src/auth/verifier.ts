import { decodeProtectedHeader } from "jose";
import { type JwtIdentity, verifyJwt, verifyJwtJwks } from "./jwt";

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

export interface TokenVerifierOptions {
  /** HS256 shared secret; absent -> HS256 tokens are rejected. */
  secret?: string;
  /** Local JWKS document (inline or file-loaded); absent -> asymmetric tokens are rejected. */
  jwks?: Record<string, unknown>;
  /** Asymmetric allowlist (default RS256/ES256/EdDSA). HS256 never verifies against the JWKS. */
  algorithms?: string[];
  maxAgeSeconds?: number;
  /** THE-456: when set, jose enforces the token's `aud`; a token minted for another resource is
   *  rejected. The HTTP edge defaults this to the PRM `resource` URI. Undefined -> not checked. */
  audience?: string | string[];
  /** THE-456: when set, jose enforces the token's `iss`. Undefined -> not checked. */
  issuer?: string;
}

/**
 * THE-297: alg-routing verifier. The token's protected header picks the verification path —
 * HS256 goes ONLY to the shared secret, everything else ONLY to the JWKS — so a public key can
 * never be misused as an HMAC secret (the classic alg-confusion attack) and rotation is
 * kid-based inside the JWKS. Either side may be absent; tokens for the missing side reject.
 */
export function createTokenVerifier(o: TokenVerifierOptions): TokenVerifier {
  return {
    verify: async (token) => {
      const header = decodeProtectedHeader(token);
      if (header.alg === "HS256") {
        if (!o.secret) throw new Error("HS256 token but no jwtSecret configured");
        return verifyJwt(token, o.secret, {
          maxAgeSeconds: o.maxAgeSeconds,
          audience: o.audience,
          issuer: o.issuer,
        });
      }
      if (!o.jwks) throw new Error(`${String(header.alg)} token but no JWKS configured`);
      return verifyJwtJwks(token, o.jwks, {
        maxAgeSeconds: o.maxAgeSeconds,
        algorithms: o.algorithms,
        audience: o.audience,
        issuer: o.issuer,
      });
    },
  };
}
