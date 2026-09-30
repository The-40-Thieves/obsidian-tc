// `auth.mode: "oidc"` — verify access tokens issued by an EXTERNAL OpenID Connect provider.
//
// VERIFICATION ONLY. obsidian-tc stays a resource server here; nothing in this file issues, refreshes
// or registers anything (the bundled authorization server is a separate design under `auth.as`).
//
// Trust chain: the operator configures an https `issuer` and an `audience`. At boot the discovery
// document is fetched from `<issuer>/.well-known/openid-configuration` and accepted only when its
// `issuer` equals the configured one exactly; its `jwks_uri` (or the operator's override) feeds
// jose's remote key set. A failure to discover REFUSES TO BOOT (the caller throws), and a refresh
// that fails later refuses tokens: there is no stale-document fallback, because a key source that
// silently degrades is how a rotated-out key keeps verifying.
//
// The token is then held to: signature by a key of that set with an algorithm from the CONFIGURED
// allowlist (never the header alone; HS*/none cannot be configured), exact `iss`, `aud`, `exp`,
// `nbf` and `iat` with a small bounded clock tolerance, `exp`/`iat`/subject present, a JOSE `typ`
// that is an access-token type, and (optionally) `client_id`/`azp` and extra required claims.
// The identity then goes through the SAME `identityFrom` jwt mode uses, so age cap, revocation by
// `jti` (auth.db tombstones included), `auth.requireJti`, scopes, vault binding and personas are one
// code path with jwt mode, not a parallel one.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { customFetch, decodeProtectedHeader, jwtVerify } from "jose";
import {
  AuthRejection,
  type ClaimMapping,
  claimAt,
  classifyJwtFailure,
  createRemoteJwks,
  identityFrom,
  type JwtIdentity,
  subjectOf,
} from "./jwt";
import {
  boundedJwksFetch,
  discoverOidc,
  IDP_FETCH_TIMEOUT_MS,
  OidcFetchError,
} from "./oidc-discovery";
import type { AuthRegistry } from "./registry";
import type { TokenVerifier } from "./verifier";

type AuthConfig = ServerConfig["auth"];

export interface OidcDeps {
  /** Test seam; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** The revocation registry (auth.db). Optional: without it nothing is revocable. */
  registry?: AuthRegistry;
  /** Epoch ms, for the discovery-cache TTL only. */
  now?: () => number;
  /** Per-request timeout for discovery and the JWKS. Default 5000. */
  timeoutMs?: number;
  /** jose's minimum gap between JWKS refetches triggered by an unknown `kid`. Default 30000. */
  jwksCooldownMs?: number;
}

export interface OidcDescription {
  issuer: string;
  jwksUri: string;
  audience: string | string[];
  allowedAlgs: string[];
  discoveredAt: number;
}

export interface OidcVerifier extends TokenVerifier {
  describe(): OidcDescription;
}

/** After a failed refresh, do not hammer the IdP: refuse for this long before trying again. */
const REFRESH_RETRY_MS = 15_000;

const ACCESS_TOKEN_TYPES = new Set(["at+jwt", "application/at+jwt"]);
/** Access tokens from IdPs that predate RFC 9068 carry `JWT` (Entra), `Bearer` (Keycloak) or no `typ`;
 *  accepted unless strict. Keycloak's ID and refresh tokens are `ID` and `Refresh`, so they stay refused. */
const LEGACY_TYPES = new Set(["jwt", "application/jwt", "bearer"]);

function isIdpFailure(e: unknown): boolean {
  if (e instanceof OidcFetchError) return true;
  const code = (e as { code?: string } | null)?.code;
  return code === "ERR_JWKS_TIMEOUT" || code === "ERR_JWKS_INVALID";
}

export async function createOidcVerifier(
  auth: AuthConfig,
  deps: OidcDeps = {},
): Promise<OidcVerifier> {
  const cfg = auth.oidc;
  if (auth.mode !== "oidc" || cfg === undefined) {
    throw new Error("createOidcVerifier: auth.mode is not 'oidc' or auth.oidc is missing");
  }
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? IDP_FETCH_TIMEOUT_MS;
  const ttlMs = cfg.discoveryCacheSeconds * 1000;
  const allowed = cfg.allowedAlgs as string[];
  const mapping: ClaimMapping = { ...cfg.claimMapping };
  const registry = deps.registry;
  const isRevoked = registry === undefined ? undefined : (jti: string) => registry.isRevoked(jti);
  // jose only sees top-level names; the operator's `requiredClaims` may be dotted paths, checked below.
  const requiredClaims = ["exp", "iat"];

  interface State {
    jwksUri: string;
    keys: ReturnType<typeof createRemoteJwks>;
    fetchedAt: number;
  }
  const load = async (): Promise<Omit<State, "keys">> => {
    const d = await discoverOidc(cfg.issuer, { fetch: deps.fetch, timeoutMs });
    const jwksUri = cfg.jwksUri ?? d.jwksUri;
    return { jwksUri, fetchedAt: now() };
  };
  const buildKeys = (jwksUri: string) =>
    createRemoteJwks(jwksUri, {
      timeoutDuration: timeoutMs,
      ...(deps.jwksCooldownMs !== undefined ? { cooldownDuration: deps.jwksCooldownMs } : {}),
      [customFetch]: boundedJwksFetch({ fetch: deps.fetch }),
    });

  // Boot discovery: any failure propagates as a clear, issuer-naming error and the caller refuses to start.
  let state: State;
  try {
    const first = await load();
    state = { ...first, keys: buildKeys(first.jwksUri) };
  } catch (e) {
    throw new Error(
      `auth.mode is 'oidc' but the identity provider ${cfg.issuer} could not be discovered, so the server will not start: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }

  let refreshing: Promise<State> | undefined;
  let failedAt: { at: number; error: unknown } | undefined;

  const fresh = async (): Promise<State> => {
    if (now() - state.fetchedAt < ttlMs) return state;
    if (failedAt !== undefined && now() - failedAt.at < REFRESH_RETRY_MS) throw failedAt.error;
    refreshing ??= (async () => {
      try {
        const next = await load();
        // The key set (and its cache) is kept while the location is unchanged.
        state = {
          ...next,
          keys: next.jwksUri === state.jwksUri ? state.keys : buildKeys(next.jwksUri),
        };
        failedAt = undefined;
        return state;
      } catch (e) {
        failedAt = { at: now(), error: e };
        throw e;
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  const verify = async (token: string): Promise<JwtIdentity> => {
    try {
      const header = decodeProtectedHeader(token);
      // The allowlist is the operator's. Checked before any key is fetched so an `alg: none` or HS256
      // token costs no outbound request, and again by jose (`algorithms`) as the enforcing check.
      if (typeof header.alg !== "string" || !allowed.includes(header.alg)) {
        throw new AuthRejection("unsupported_alg");
      }
      const current = await fresh();
      const tolerance = cfg.clockToleranceSeconds;
      const { payload, protectedHeader } = await jwtVerify(token, current.keys, {
        algorithms: allowed,
        issuer: cfg.issuer,
        audience: cfg.audience,
        clockTolerance: tolerance,
        requiredClaims,
      });

      const nowSec = Math.floor(Date.now() / 1000);
      if (typeof payload.iat !== "number" || payload.iat > nowSec + tolerance) {
        throw new AuthRejection(
          typeof payload.iat === "number" ? "token_not_yet_valid" : "missing_claim",
        );
      }
      const typ =
        typeof protectedHeader.typ === "string" ? protectedHeader.typ.toLowerCase() : undefined;
      const typOk =
        typ !== undefined && ACCESS_TOKEN_TYPES.has(typ)
          ? true
          : !cfg.requireAtJwtType && (typ === undefined || LEGACY_TYPES.has(typ));
      if (!typOk) throw new AuthRejection("invalid_token_type");
      if (cfg.clientId !== undefined) {
        const client = payload.client_id ?? payload.azp;
        if (client !== cfg.clientId) throw new AuthRejection("client_mismatch");
      }
      for (const claim of cfg.requiredClaims ?? []) {
        if (claimAt(payload, claim) === undefined) throw new AuthRejection("missing_claim");
      }
      if (subjectOf(payload, mapping) === undefined) throw new AuthRejection("missing_claim");

      return identityFrom(
        payload,
        auth.tokenTtlSeconds,
        { isRevoked, requireJti: auth.requireJti },
        mapping,
      );
    } catch (e) {
      if (isIdpFailure(e)) {
        throw new AuthRejection("idp_unavailable", { cause: e });
      }
      throw classifyJwtFailure(e, token);
    }
  };

  return {
    verify,
    describe: () => ({
      issuer: cfg.issuer,
      jwksUri: state.jwksUri,
      audience: cfg.audience,
      allowedAlgs: [...allowed],
      discoveredAt: state.fetchedAt,
    }),
  };
}
