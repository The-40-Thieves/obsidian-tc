// OIDC discovery + bounded fetching for `auth.mode: "oidc"`. The IdP is an external, semi-trusted
// network peer, so every fetch here is https-only, refuses redirects, has a timeout and a byte cap,
// and the discovery document is accepted only when its `issuer` equals the configured one EXACTLY
// (OpenID Connect Discovery 1.0 §4.3; a mismatch is the mix-up attack this check exists to stop).
// Where it may point is bounded too: the discovered `jwks_uri` stays on the issuer's origin (or a host
// the operator listed), carries no credentials, and no fetch is made to a non-public address.
import type { FetchImplementation } from "jose";
import { assertPublicHost, type IdpNetworkPolicy } from "./oidc-network";

/** Discovery documents are a few KiB; 64 KiB is generous and bounds memory per fetch. */
export const DISCOVERY_MAX_BYTES = 64 * 1024;
/** A JWKS of dozens of keys is well under this. */
export const JWKS_MAX_BYTES = 256 * 1024;
export const IDP_FETCH_TIMEOUT_MS = 5000;

/** The IdP could not be reached, answered wrongly, or returned something out of bounds. */
export class OidcFetchError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "OidcFetchError";
  }
}

export interface FetchBoundedOpts {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes: number;
  /** For error messages, e.g. "OIDC discovery". */
  what: string;
  accept?: string;
  signal?: AbortSignal;
  network?: IdpNetworkPolicy;
}

function requireHttps(url: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new OidcFetchError(`${what}: ${JSON.stringify(url)} is not a valid URL`);
  }
  if (u.username !== "" || u.password !== "") {
    throw new OidcFetchError(
      `${what}: ${u.origin}${u.pathname} must not carry credentials in the URL`,
    );
  }
  if (u.protocol !== "https:") {
    throw new OidcFetchError(
      `${what}: ${url} must use https (refusing to fetch identity-provider metadata over ${u.protocol.replace(":", "")})`,
    );
  }
  return u;
}

/** GET a URL as text: https only, no redirects, timeout, and a hard cap on the body size. */
export async function fetchBoundedText(url: string, o: FetchBoundedOpts): Promise<string> {
  const u = requireHttps(url, o.what);
  await assertPublicHost(
    u.hostname,
    o.network ?? {},
    (message, cause) => new OidcFetchError(message, cause === undefined ? undefined : { cause }),
    o.what,
  );
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? IDP_FETCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = o.signal === undefined ? timeout : AbortSignal.any([o.signal, timeout]);
  let res: Response;
  try {
    res = await doFetch(u.href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: o.accept ?? "application/json" },
    });
  } catch (e) {
    const timedOut = timeout.aborted;
    throw new OidcFetchError(
      timedOut
        ? `${o.what}: ${u.href} timed out after ${timeoutMs} ms`
        : `${o.what}: ${u.href} could not be fetched (${e instanceof Error ? e.message : String(e)})`,
      { cause: e },
    );
  }
  if (res.status >= 300 && res.status < 400) {
    void res.body?.cancel();
    throw new OidcFetchError(
      `${o.what}: ${u.href} answered a ${res.status} redirect; redirects are not followed`,
    );
  }
  if (res.status !== 200) {
    void res.body?.cancel();
    throw new OidcFetchError(`${o.what}: ${u.href} answered HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > o.maxBytes) {
    void res.body?.cancel();
    throw new OidcFetchError(
      `${o.what}: ${u.href} is too large (${declared} bytes declared, limit ${o.maxBytes})`,
    );
  }
  try {
    const reader = res.body?.getReader();
    if (reader === undefined) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > o.maxBytes) {
        void reader.cancel();
        throw new OidcFetchError(`${o.what}: ${u.href} is too large (over ${o.maxBytes} bytes)`);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch (e) {
    if (e instanceof OidcFetchError) throw e;
    throw new OidcFetchError(
      timeout.aborted
        ? `${o.what}: ${u.href} timed out after ${timeoutMs} ms`
        : `${o.what}: reading ${u.href} failed (${e instanceof Error ? e.message : String(e)})`,
      { cause: e },
    );
  }
}

/**
 * A `fetch` for jose's remote JWKS resolver (its `customFetch` option) that applies the same bounds.
 * jose itself follows none of these: it has no size cap and reads whatever `response.json()` yields.
 * Any failure is thrown as an OidcFetchError (a timeout keeps jose's own TimeoutError so it is
 * reported as a timeout), so the caller can tell "the IdP failed" from "the token is bad".
 */
export function boundedJwksFetch(o: {
  fetch?: typeof fetch;
  network?: IdpNetworkPolicy;
}): FetchImplementation {
  return async (url, init) => {
    const text = await fetchBoundedText(url, {
      ...(o.fetch !== undefined ? { fetch: o.fetch } : {}),
      ...(o.network !== undefined ? { network: o.network } : {}),
      // jose owns the timeout for the JWKS request (its `timeoutDuration`); honour its signal.
      timeoutMs: 60_000,
      signal: init.signal,
      maxBytes: JWKS_MAX_BYTES,
      what: "OIDC JWKS",
      accept: "application/json, application/jwk-set+json",
    });
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  };
}

export interface OidcDiscovery {
  issuer: string;
  jwksUri: string;
  document: Record<string, unknown>;
}

/** `<issuer>/.well-known/openid-configuration`, a terminating `/` on the issuer removed first (§4). */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

/** What `auth.oidc` says about where discovery may lead. */
export interface DiscoveryPolicy extends IdpNetworkPolicy {
  /** Hostnames a discovered `jwks_uri` may use besides the issuer's own origin. */
  allowedJwksHosts?: readonly string[];
  /** Default true: the discovered `jwks_uri` must share the issuer's origin or be an allowed host.
   *  False when the operator configured `jwksUri` explicitly (the discovered value is then unused). */
  pinJwksUri?: boolean;
}

/** The discovery policy an `auth.oidc` block implies; the server and `doctor` both build it here. */
export function discoveryPolicyOf(cfg: {
  jwksUri?: string | undefined;
  allowedJwksHosts?: readonly string[] | undefined;
  allowPrivateNetwork?: boolean | undefined;
}): DiscoveryPolicy {
  return {
    pinJwksUri: cfg.jwksUri === undefined,
    ...(cfg.allowedJwksHosts !== undefined ? { allowedJwksHosts: cfg.allowedJwksHosts } : {}),
    allowPrivateNetwork: cfg.allowPrivateNetwork === true,
  };
}

export async function discoverOidc(
  issuer: string,
  o: { fetch?: typeof fetch; timeoutMs?: number } & DiscoveryPolicy = {},
): Promise<OidcDiscovery> {
  const url = discoveryUrl(issuer);
  const text = await fetchBoundedText(url, {
    ...(o.fetch !== undefined ? { fetch: o.fetch } : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    network: o,
    maxBytes: DISCOVERY_MAX_BYTES,
    what: "OIDC discovery",
  });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new OidcFetchError(`OIDC discovery: ${url} did not return JSON`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new OidcFetchError(`OIDC discovery: ${url} did not return a JSON object`);
  }
  const d = doc as Record<string, unknown>;
  if (d.issuer !== issuer) {
    throw new OidcFetchError(
      `OIDC discovery: the document at ${url} names issuer ${JSON.stringify(d.issuer)}, which does not match the configured issuer ${JSON.stringify(issuer)} (compared exactly); refusing it`,
    );
  }
  if (typeof d.jwks_uri !== "string") {
    throw new OidcFetchError(`OIDC discovery: the document at ${url} has no jwks_uri`);
  }
  try {
    const jwks = requireHttps(d.jwks_uri, "OIDC discovery: jwks_uri");
    if (o.pinJwksUri !== false) {
      const sameOrigin = jwks.origin === new URL(issuer).origin;
      if (!sameOrigin && !(o.allowedJwksHosts ?? []).includes(jwks.hostname)) {
        throw new OidcFetchError(
          `OIDC discovery: jwks_uri ${jwks.origin} is not on the issuer's origin ${new URL(issuer).origin}; list its hostname in auth.oidc.allowedJwksHosts (or set auth.oidc.jwksUri) if the identity provider really serves its keys from there`,
        );
      }
    }
  } catch (e) {
    throw new OidcFetchError(
      `OIDC discovery: the document at ${url} has an unusable jwks_uri: ${(e as Error).message}`,
    );
  }
  return { issuer, jwksUri: d.jwks_uri, document: d };
}
