// Verification rules for an access token signed by an `as`-purpose registry key (the bundled
// authorization server's RFC 9068 JWT, design v2 section 4.2). The registry row a token's `kid` names
// decides that these rules apply; they are NOT chosen by anything the token says about itself.
//
// Stricter than the hand-minted path on purpose: the issuer is the AS's own, never the global
// `auth.issuer` (that one belongs to `mint` keys), the JOSE `typ` is `at+jwt`, and `client_id`,
// `aud` (exactly the protected resource), `iss` and `jti` are all required, so an `as` key can
// never be made to vouch for a token that is not an access token for THIS resource.
//
// Cross-slice contract: the issuing path (slice S5) must sign every access token with header
// `typ: "at+jwt"` and claims iss, sub, aud, client_id, scope, iat, exp, jti, or this verifier
// refuses it. jose compares `typ` case-insensitively and accepts the `application/` media-type form
// (RFC 8725 section 3.11), which test/auth-key-purpose.test.ts pins.
import { jwtVerify } from "jose";
import {
  AuthRejection,
  classifyJwtFailure,
  identityFrom,
  type JwtIdentity,
  type RevocationOpts,
} from "./jwt";

export interface AsTokenRules {
  /** `auth.as.issuer`: the one issuer an `as` key's tokens may carry. */
  issuer: string;
  /** `auth.resource`: the one audience an `as` key's tokens may carry. */
  resource: string;
  maxAgeSeconds?: number;
}

/** Claims an `as` token must carry (jose reports a missing one as `missing_claim`). */
const REQUIRED_CLAIMS = ["exp", "iss", "aud", "client_id", "jti"];

/** `scope` is the RFC 9068 claim, and the only one read: a stray `scopes` array (which the generic
 *  extractor prefers) must not be able to shadow what the AS granted. */
const scopesOf = (scope: unknown): Set<string> =>
  new Set(typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : []);

export async function verifyAsToken(
  token: string,
  key: Parameters<typeof jwtVerify>[1],
  alg: string,
  rules: AsTokenRules,
  revocation: RevocationOpts,
): Promise<JwtIdentity> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [alg],
      typ: "at+jwt",
      issuer: rules.issuer,
      audience: rules.resource,
      requiredClaims: REQUIRED_CLAIMS,
    });
    // jose accepts an audience LIST that merely contains the resource; the AS issues the string.
    if (payload.aud !== rules.resource) throw new AuthRejection("audience_mismatch");
    if (typeof payload.client_id !== "string" || payload.client_id === "") {
      throw new AuthRejection("missing_claim");
    }
    const identity = identityFrom(payload, rules.maxAgeSeconds, revocation);
    return {
      ...identity,
      scopes: scopesOf(payload.scope),
      keyPurpose: "as",
      clientId: payload.client_id,
    };
  } catch (e) {
    throw classifyJwtFailure(e, token);
  }
}
