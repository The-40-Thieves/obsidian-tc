import { isQualifiedScope } from "@the-40-thieves/obsidian-tc-shared";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type RemoteJWKSetOptions,
} from "jose";
import { OidcFetchError } from "./oidc-discovery";

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
  | "misconfigured" // server-side: no secret / no JWKS for the token's alg
  | "token_revoked" // the token's jti is revoked in the registry (auth revoke), though it has not expired
  | "unknown_key" // the token's `kid` names no key in the signing-key registry
  | "key_retired" // the signing key is retired, or retiring with its window elapsed
  | "registry_lost" // the registry was initialised but auth.db is missing/empty: refuse, never trust
  | "jti_required" // auth.requireJti is on and the token carries no jti (so it could never be revoked)
  | "token_not_yet_valid" // `nbf` (or an `iat`) is in the future beyond the clock tolerance
  | "invalid_token_type" // oidc, and an `as`-purpose key's tokens: the JOSE `typ` header is not an access-token type
  | "client_mismatch" // oidc: auth.oidc.clientId is set and the token's client_id/azp differs or is absent
  | "claim_not_allowed" // oidc: a mapped persona/vault claim is not a string or is outside its allowlist
  | "idp_unavailable" // oidc, or jwt mode's remote `jwksUri`: the key set could not be fetched or was refused, so nothing can be verified
  | "persona_denied"; // THE-647 item 2: `persona` claim named an unconfigured persona, or a
// vault outside that persona's `vaults` — resolved one layer up in auth/persona.ts, not by
// jwtVerify itself, but the SAME external "invalid or expired token" message applies: an
// unauthenticated caller must not learn which check failed.

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
export function classifyJwtFailure(err: unknown, token: string): AuthRejection {
  if (err instanceof AuthRejection) return err;
  const { caller, expStillFuture } = peek(token);
  // A remote key set that was refused (address policy, redirect, size) or could not be fetched.
  if (err instanceof OidcFetchError) {
    return new AuthRejection("idp_unavailable", { caller, expStillFuture, cause: err });
  }
  const code = (err as { code?: string })?.code;
  const claim = (err as { claim?: string })?.claim;

  let reason: AuthRejectionReason = "malformed";
  // jose gave up waiting for the remote key set (only a remote fetch raises this).
  if (code === "ERR_JWKS_TIMEOUT") reason = "idp_unavailable";
  else if (code === "ERR_JWT_EXPIRED") reason = "token_expired";
  else if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") reason = "bad_signature";
  else if (code === "ERR_JOSE_ALG_NOT_ALLOWED") reason = "unsupported_alg";
  else if (code === "ERR_JWKS_NO_MATCHING_KEY") reason = "unknown_key";
  else if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    const why = (err as { reason?: string })?.reason;
    if (why === "missing") reason = "missing_claim";
    else if (claim === "aud") reason = "audience_mismatch";
    else if (claim === "iss") reason = "issuer_mismatch";
    else if (claim === "nbf") reason = "token_not_yet_valid";
    else if (claim === "typ") reason = "invalid_token_type";
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
  /** THE-647 item 2: the raw `persona` claim, unresolved. This module verifies the token only —
   *  it has no access to the server's `personas` config, so resolving this name to an effective
   *  scope/vault/toolVisibility bundle (and failing closed on an unrecognised one) happens one
   *  layer up, in auth/persona.ts, from the caller that DOES hold the config. */
  persona?: string;
  /** The token's `jti` when it carries one — the handle `auth revoke` acts on. */
  jti?: string;
  /** Set to `as` when the token was signed by an authorization-server registry key (auth/as-token.ts).
   *  Absent for every other token. The HTTP edge narrows a persona by the token's scopes only when
   *  this is set; a hand-minted persona token keeps "the persona's scopes replace the token's". */
  keyPurpose?: "as";
  /** `as` tokens only: the OAuth client the token was issued to (`client_id`). */
  clientId?: string;
}

/** Options every verify path shares. `isRevoked` is consulted with the token's `jti` AFTER the
 *  signature and claims verified, so an unauthenticated caller can never use it to probe jtis. */
export interface RevocationOpts {
  isRevoked?: (jti: string) => boolean;
  /** Reject a token that carries no `jti` (auth.requireJti). A jti-less token can only be killed
   *  by rotating its signing key. */
  requireJti?: boolean;
  /** Throws `registry_lost` when the registry is lost or partly lost. Runs for EVERY verified token,
   *  jti or not: a jti-less token is never looked up, so a wiped registry would still admit it. */
  assertRegistryUsable?: () => void;
}

/** Resolves the HS256 key for a token from its protected header (`kid`). Throws `AuthRejection`
 *  when no acceptable key exists. Called by jose BEFORE the signature is verified. */
export type HmacKeyResolver = (header: { kid?: string }) => Uint8Array;

/**
 * Verify an HS256 JWT and extract caller identity + granted scopes. Throws on a bad
 * signature, a missing or elapsed `exp`, a token older than `maxAgeSeconds` (when it
 * carries `iat`), or a non-HS256 algorithm (the caller maps that to 401).
 * Authentication only: authorization (scope/ACL enforcement) stays in dispatch.
 */
export async function verifyJwt(
  token: string,
  secret: string | HmacKeyResolver,
  opts: {
    maxAgeSeconds?: number;
    audience?: string | string[];
    issuer?: string;
  } & RevocationOpts = {},
): Promise<JwtIdentity> {
  if (!secret) throw new Error("empty secret not allowed");
  const key =
    typeof secret === "string"
      ? new TextEncoder().encode(secret)
      : (header: { kid?: string }) => secret(header);

  // requiredClaims:["exp"] closes the "token without exp never expires" gap — jose only
  // enforces expiry when exp is present, so demand it. maxAgeSeconds (from auth.tokenTtlSeconds)
  // additionally caps token age, but only when the token carries iat, so existing exp-only
  // tokens keep working. THE-456: audience/issuer are enforced by jose only when configured
  // (undefined = not checked), so local self-issued tokens are unaffected.
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      requiredClaims: ["exp"],
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
    });
    return identityFrom(payload, opts.maxAgeSeconds, opts);
  } catch (e) {
    throw classifyJwtFailure(e, token);
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
  } & RevocationOpts = {},
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
    return identityFrom(payload, opts.maxAgeSeconds, opts);
  } catch (e) {
    throw classifyJwtFailure(e, token);
  }
}

/**
 * Where an `oidc` identity comes from. Absent (jwt mode): `sub`, `scopes`/`scope`, and the fixed
 * `vault` / `persona` claims, exactly as before. Present: ONLY the named claims are read, so a stray
 * `scopes` or `persona` claim an IdP happens to emit can never grant anything.
 */
export interface ClaimMapping {
  subject: ClaimPath;
  scopes: ClaimPath;
  /** Role/group value -> the obsidian-tc scopes it grants. Own keys only. */
  scopeMap?: Record<string, readonly string[]>;
  principal?: ClaimPath;
  vault?: ClaimPath;
  /** Vault ids the `vault` claim may carry; a value outside it (or a non-string) refuses the token. */
  allowedVaults?: readonly string[];
  persona?: ClaimPath;
  /** Persona names the `persona` claim may carry; a value outside it (or a non-string) refuses the token. */
  allowedPersonas?: readonly string[];
  /** Told of each scope-claim value that was dropped for not being fully qualified or mapped. */
  onDroppedScope?: (value: string) => void;
}

/** A claim location: a dotted path (string) into nested objects, or literal segments (array). */
export type ClaimPath = string | readonly string[];

/**
 * A claim by dotted path (`a.b.c`, walking NESTED objects only) or by array of literal segments.
 * A top-level claim whose own name contains dots is reachable only through the array form, never
 * through the dotted string, so a forged `realm_access.roles` claim cannot shadow the nested one.
 * Own properties only, so `__proto__`/`constructor` never resolve.
 */
export function claimAt(payload: Record<string, unknown>, path: ClaimPath): unknown {
  let cur: unknown = payload;
  for (const part of typeof path === "string" ? path.split(".") : path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    const own = Object.getOwnPropertyDescriptor(cur, part);
    if (own === undefined) return undefined;
    cur = own.value;
  }
  return cur;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Non-empty subject claim by the mapping, or undefined. */
export function subjectOf(
  payload: Record<string, unknown>,
  mapping?: ClaimMapping,
): string | undefined {
  if (mapping === undefined) return asString(payload.sub);
  const v = asString(claimAt(payload, mapping.subject));
  return v === "" ? undefined : v;
}

export function identityFrom(
  payload: Record<string, unknown>,
  maxAgeSeconds: number | undefined,
  revocation: RevocationOpts = {},
  mapping?: ClaimMapping,
): JwtIdentity {
  const subject = subjectOf(payload, mapping);
  const tooOld =
    maxAgeSeconds !== undefined &&
    typeof payload.iat === "number" &&
    Math.floor(Date.now() / 1000) - payload.iat > maxAgeSeconds;
  if (tooOld)
    throw new AuthRejection("token_max_age", {
      caller: subject ?? null,
      // The diagnostic that matters: aged out while exp is still valid == misconfiguration,
      // not an expired credential.
      expStillFuture:
        typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000),
    });
  const caller = subject ?? null;
  // A present non-string `jti` must not read as "no jti" (never looked up, so never revocable).
  if (payload.jti !== undefined && typeof payload.jti !== "string") {
    throw new AuthRejection("missing_claim", { caller });
  }
  const jti = typeof payload.jti === "string" ? payload.jti : undefined;
  revocation.assertRegistryUsable?.();
  if (jti === undefined && revocation.requireJti === true) {
    throw new AuthRejection("jti_required", { caller });
  }
  if (jti !== undefined && revocation.isRevoked?.(jti))
    throw new AuthRejection("token_revoked", { caller });
  if (mapping !== undefined) {
    const principal =
      mapping.principal === undefined ? undefined : asString(claimAt(payload, mapping.principal));
    return {
      caller: principal ?? caller,
      scopes: scopesFromClaim(claimAt(payload, mapping.scopes), mapping),
      ...(jti !== undefined ? { jti } : {}),
      vault: allowlistedClaim(payload, mapping.vault, mapping.allowedVaults, caller),
      persona: allowlistedClaim(payload, mapping.persona, mapping.allowedPersonas, caller),
    };
  }
  return {
    caller,
    scopes: extractScopes(payload),
    ...(jti !== undefined ? { jti } : {}),
    vault: typeof payload.vault === "string" ? payload.vault : undefined,
    persona: typeof payload.persona === "string" ? payload.persona : undefined,
  };
}

/** A persona/vault claim is a bearer capability: absent -> undefined; present but not a string or
 *  not on the operator's list -> the token is refused (ignoring it would fall through to a wider grant). */
function allowlistedClaim(
  payload: Record<string, unknown>,
  path: ClaimPath | undefined,
  allowed: readonly string[] | undefined,
  caller: string | null,
): string | undefined {
  if (path === undefined) return undefined;
  const v = claimAt(payload, path);
  if (v === undefined) return undefined;
  if (typeof v !== "string" || allowed === undefined || !allowed.includes(v)) {
    throw new AuthRejection("claim_not_allowed", { caller });
  }
  return v;
}

/** The scopes an `oidc` token grants: a `scopeMap` value grants exactly its list, else only a
 *  fully-qualified scope passes. A bare IdP role like `admin` would read as a family wildcard: dropped. */
function scopesFromClaim(v: unknown, mapping: ClaimMapping): Set<string> {
  const raw = Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string")
    : typeof v === "string"
      ? v.split(/\s+/).filter(Boolean)
      : [];
  const out = new Set<string>();
  for (const value of raw) {
    const mapped =
      mapping.scopeMap !== undefined && Object.hasOwn(mapping.scopeMap, value)
        ? mapping.scopeMap[value]
        : undefined;
    if (mapped !== undefined) for (const scope of mapped) out.add(scope);
    else if (isQualifiedScope(value)) out.add(value);
    else mapping.onDroppedScope?.(value);
  }
  return out;
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

/**
 * THE-658: a JWKS resolver backed by an authorization server's `jwks_uri`.
 *
 * Built ONCE per server (jose caches the fetched set internally and re-fetches only when it sees an
 * unknown `kid`), so this is not a fetch per request. Rebuilding it per verification would turn
 * every token check into an outbound HTTP call and defeat the cache.
 *
 * A fetch failure REJECTS the token. There is deliberately no fallback to the inline/file set: a
 * key source that silently degrades to a different key source is how a rotated-out key keeps
 * working, and the alg-routing guarantee (asymmetric verifies only against the JWKS) depends on
 * there being exactly one asymmetric source in play.
 */
export function createRemoteJwks(
  uri: string,
  options?: RemoteJWKSetOptions,
): ReturnType<typeof createRemoteJWKSet> {
  return createRemoteJWKSet(new URL(uri), options);
}

/**
 * Verify an asymmetric JWT against a PRE-BUILT key resolver (remote or local).
 *
 * Split from verifyJwtJwks, which takes a raw document and builds a local set per call — fine for a
 * static document, wrong for a remote one.
 */
export async function verifyJwtWithKeySet(
  token: string,
  keySet: Parameters<typeof jwtVerify>[1],
  opts: {
    maxAgeSeconds?: number;
    algorithms?: string[];
    audience?: string | string[];
    issuer?: string;
  } & RevocationOpts = {},
): Promise<JwtIdentity> {
  try {
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: opts.algorithms ?? DEFAULT_ASYMMETRIC_ALGS,
      requiredClaims: ["exp"],
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
    });
    return identityFrom(payload, opts.maxAgeSeconds, opts);
  } catch (e) {
    throw classifyJwtFailure(e, token);
  }
}
