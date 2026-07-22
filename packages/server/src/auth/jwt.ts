import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";

/**
 * THE-520: why a token was refused. Every value is OPERATOR-facing — it belongs in logs and the
 * `auth_rejections_total` counter, never in the response body: telling an unauthenticated caller
 * which check failed turns the endpoint into an oracle. The client keeps one undifferentiated 401.
 */
export type AuthRejectionReason =
  | "token_max_age" // aged past auth.tokenTtlSeconds (measured from iat), regardless of exp
  | "token_expired" // exp elapsed
  | "bad_signature"
  | "missing_claim" // a requiredClaim (exp) is absent
  | "audience_mismatch" // THE-456
  | "issuer_mismatch" // THE-456
  | "unsupported_alg"
  | "malformed"
  | "misconfigured"; // server-side: no secret / no JWKS for the token's alg

export class AuthRejection extends Error {
  readonly reason: AuthRejectionReason;
  /** Token `sub` when the token decodes. UNVERIFIED — the signature may be exactly what failed.
   *  Safe for a log line, never for an authorization decision. */
  readonly caller: string | null;
  /** True when the token aged out while its own `exp` is still in the future. That combination
   *  means a long-lived token was minted under a short tokenTtlSeconds — the misconfiguration
   *  that hid a 5-day outage, and the one worth calling out explicitly. */
  readonly expStillFuture: boolean;

  constructor(
    reason: AuthRejectionReason,
    opts: { caller?: string | null; expStillFuture?: boolean; cause?: unknown } = {},
  ) {
    super(`auth rejected: ${reason}`, { cause: opts.cause });
    this.name = "AuthRejection";
    this.reason = reason;
    this.caller = opts.caller ?? null;
    this.expStillFuture = opts.expStillFuture ?? false;
  }
}

/** Best-effort claim peek for diagnostics. Never throws; never feeds an authz decision. */
function peek(token: string): { caller: string | null; expStillFuture: boolean } {
  try {
    const p = decodeJwt(token);
    return {
      caller: typeof p.sub === "string" ? p.sub : null,
      expStillFuture: typeof p.exp === "number" && p.exp > Math.floor(Date.now() / 1000),
    };
  } catch {
    return { caller: null, expStillFuture: false };
  }
}

/** Map a jose verification failure onto a typed reason. Anything unrecognized stays `malformed`
 *  rather than being guessed at — a wrong reason in a log is worse than a vague one. */
function classify(err: unknown, token: string): AuthRejection {
  if (err instanceof AuthRejection) return err;
  const { caller, expStillFuture } = peek(token);
  const code = (err as { code?: string })?.code;
  const claim = (err as { claim?: string })?.claim;

  let reason: AuthRejectionReason = "malformed";
  if (code === "ERR_JWT_EXPIRED") reason = "token_expired";
  else if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") reason = "bad_signature";
  else if (code === "ERR_JOSE_ALG_NOT_ALLOWED") reason = "unsupported_alg";
  else if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    const why = (err as { reason?: string })?.reason;
    if (why === "missing") reason = "missing_claim";
    else if (claim === "aud") reason = "audience_mismatch";
    else if (claim === "iss") reason = "issuer_mismatch";
  }
  return new AuthRejection(reason, { caller, expStillFuture, cause: err });
}

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
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      requiredClaims: ["exp"],
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
    });
    return identityFrom(payload, opts.maxAgeSeconds);
  } catch (e) {
    throw classify(e, token);
  }
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
  try {
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: opts.algorithms ?? DEFAULT_ASYMMETRIC_ALGS,
      requiredClaims: ["exp"],
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
    });
    return identityFrom(payload, opts.maxAgeSeconds);
  } catch (e) {
    throw classify(e, token);
  }
}

function identityFrom(
  payload: Record<string, unknown>,
  maxAgeSeconds: number | undefined,
): JwtIdentity {
  const tooOld =
    maxAgeSeconds !== undefined &&
    typeof payload.iat === "number" &&
    Math.floor(Date.now() / 1000) - payload.iat > maxAgeSeconds;
  if (tooOld)
    throw new AuthRejection("token_max_age", {
      caller: typeof payload.sub === "string" ? payload.sub : null,
      // The diagnostic that matters: aged out while exp is still valid == misconfiguration,
      // not an expired credential.
      expStillFuture:
        typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000),
    });
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
