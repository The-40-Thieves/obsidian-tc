// OIDC discovery + bounded fetching for `auth.mode: "oidc"`. The IdP is an external, semi-trusted
// network peer, so every fetch here is https-only, refuses redirects, has a timeout and a byte cap,
// and the discovery document is accepted only when its `issuer` equals the configured one EXACTLY
// (OpenID Connect Discovery 1.0 §4.3; a mismatch is the mix-up attack this check exists to stop).
// Where it may point is bounded too: the discovered `jwks_uri` stays on the issuer's origin (or a host
// the operator listed), carries no credentials, and no fetch is made to a non-public address.
import type { FetchImplementation } from "jose";
import { createPinnedFetch } from "../gateway/plain-http";
import { ProviderBodyTooLargeError, readBodyText } from "../gateway/read-body";
import {
  redactEndpoint,
  redactEndpointWithPath,
  redactUrlsInText,
  scrubEndpointFromMessage,
} from "../telemetry/redact-endpoint";
import { assertPublicHost, type IdpNetworkPolicy, type ValidatedAddress } from "./oidc-network";

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
  /** Replaces the https-only, public-address-only rule: it receives the parsed URL, may admit
   *  `http:` as well, and returns the addresses to connect to (it throws to refuse). Redirects,
   *  the timeout and the body cap apply as ever. JWT mode's `auth.jwksUri` (auth/jwks-network.ts). */
  target?: (url: URL) => Promise<readonly ValidatedAddress[]>;
  /** The URL's path is public and may be shown in messages. Only the discovery document URL is:
   *  it is derived from the issuer, which every token carries. A key-set URL is NOT -- its path can
   *  be a credential (`/jwks/<token>`) -- so by default only its origin is ever shown. */
  pathIsPublic?: boolean;
  /** Called with the response once it is a 200 within bounds, before the body is read: lets a caller
   *  that needs a header (the CIMD cache lifetime) read it without a second request. */
  onResponse?: (res: Response) => void;
}

function requireHttps(url: string, what: string, pathIsPublic = false, allowHttp = false): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new OidcFetchError(
      `${what}: ${pathIsPublic ? redactUrlsInText(JSON.stringify(url)) : "(unparseable)"} is not a valid URL`,
    );
  }
  if (u.username !== "" || u.password !== "") {
    throw new OidcFetchError(
      `${what}: ${u.origin}${pathIsPublic ? u.pathname : ""} must not carry credentials in the URL`,
    );
  }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) {
    throw new OidcFetchError(
      `${what}: ${(pathIsPublic ? redactEndpointWithPath : redactEndpoint)(url)} must use ${allowHttp ? "http or https" : "https"} (refusing to fetch identity-provider metadata over ${u.protocol.replace(":", "")})`,
    );
  }
  return u;
}

/** `p`, or `timedOut()` once `deadline` fires first. The loser is left running but its failure is
 *  swallowed, so an abandoned name lookup that later rejects is not an unhandled rejection. */
function raceDeadline<T>(p: Promise<T>, deadline: AbortSignal, timedOut: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timedOut());
    p.then(resolve, reject).finally(() => deadline.removeEventListener("abort", onAbort));
    if (deadline.aborted) onAbort();
    else deadline.addEventListener("abort", onAbort, { once: true });
  });
}

/** GET a URL as text: https only, no redirects, timeout, and a hard cap on the body size. */
export async function fetchBoundedText(url: string, o: FetchBoundedOpts): Promise<string> {
  const u = requireHttps(url, o.what, o.pathIsPublic, o.target !== undefined);
  const shown = (o.pathIsPublic === true ? redactEndpointWithPath : redactEndpoint)(u.href);
  // ONE deadline covers the name lookup, the connection and the body: it starts before the lookup,
  // which has no timeout of its own, so a name server that never answers cannot hold the caller.
  const timeoutMs = o.timeoutMs ?? IDP_FETCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = o.signal === undefined ? timeout : AbortSignal.any([o.signal, timeout]);
  const deadlineError = () =>
    new OidcFetchError(`${o.what}: ${shown} timed out after ${timeoutMs} ms`);
  const validating =
    o.target !== undefined
      ? o.target(u)
      : assertPublicHost(
          u.hostname,
          o.network ?? {},
          (message, cause) =>
            new OidcFetchError(message, cause === undefined ? undefined : { cause }),
          o.what,
        );
  const validated = await raceDeadline(validating, timeout, deadlineError);
  // A transport error can embed the request URL verbatim; strip it (and, for a URL whose path is
  // not public, the path too) before it reaches a message.
  const scrub = (e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    const text = o.pathIsPublic === true ? raw : scrubEndpointFromMessage(raw, u.href);
    return redactUrlsInText(
      o.pathIsPublic === true || u.pathname === "/" ? text : text.split(u.pathname).join("/…"),
    );
  };
  // An injected fetch is the test seam. Otherwise connect to the addresses just validated (never
  // the name again); with the private-network opt-in nothing was validated, so the ordinary fetch.
  const doFetch =
    o.fetch ?? (validated === undefined ? globalThis.fetch : createPinnedFetch(validated));
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
        ? `${o.what}: ${shown} timed out after ${timeoutMs} ms`
        : `${o.what}: ${shown} could not be fetched (${scrub(e)})`,
    );
  }
  if (res.status >= 300 && res.status < 400) {
    void res.body?.cancel();
    throw new OidcFetchError(
      `${o.what}: ${shown} answered a ${res.status} redirect; redirects are not followed`,
    );
  }
  if (res.status !== 200) {
    void res.body?.cancel();
    throw new OidcFetchError(`${o.what}: ${shown} answered HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > o.maxBytes) {
    void res.body?.cancel();
    throw new OidcFetchError(
      `${o.what}: ${shown} is too large (${declared} bytes declared, limit ${o.maxBytes})`,
    );
  }
  o.onResponse?.(res);
  try {
    return await readBodyText(res, o.maxBytes);
  } catch (e) {
    if (e instanceof ProviderBodyTooLargeError) {
      throw new OidcFetchError(`${o.what}: ${shown} is too large (over ${o.maxBytes} bytes)`);
    }
    throw new OidcFetchError(
      timeout.aborted
        ? `${o.what}: ${shown} timed out after ${timeoutMs} ms`
        : `${o.what}: reading ${shown} failed (${scrub(e)})`,
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
  /** See FetchBoundedOpts.target. */
  target?: FetchBoundedOpts["target"];
  /** For error messages. Default "OIDC JWKS". */
  what?: string;
}): FetchImplementation {
  return async (url, init) => {
    const text = await fetchBoundedText(url, {
      ...(o.fetch !== undefined ? { fetch: o.fetch } : {}),
      ...(o.network !== undefined ? { network: o.network } : {}),
      ...(o.target !== undefined ? { target: o.target } : {}),
      // jose owns the timeout for the JWKS request (its `timeoutDuration`); honour its signal.
      timeoutMs: 60_000,
      signal: init.signal,
      maxBytes: JWKS_MAX_BYTES,
      what: o.what ?? "OIDC JWKS",
      accept: "application/json, application/jwk-set+json",
    });
    // A 200 that is not a key set is the IdP failing, not a bad token: say so here, where it is an
    // OidcFetchError (reason `idp_unavailable`), rather than leaving jose to throw a generic error
    // that classifies as `malformed`.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OidcFetchError(`${o.what}: the response is not valid JSON`);
    }
    if (!isKeySet(parsed)) {
      throw new OidcFetchError(
        `${o.what}: the response is not a JSON Web Key Set (no "keys" array)`,
      );
    }
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  };
}

function isKeySet(v: unknown): boolean {
  return typeof v === "object" && v !== null && Array.isArray((v as { keys?: unknown }).keys);
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
  const shownDiscovery = redactEndpointWithPath(url);
  const text = await fetchBoundedText(url, {
    ...(o.fetch !== undefined ? { fetch: o.fetch } : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    network: o,
    maxBytes: DISCOVERY_MAX_BYTES,
    what: "OIDC discovery",
    pathIsPublic: true,
  });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new OidcFetchError(`OIDC discovery: ${shownDiscovery} did not return JSON`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new OidcFetchError(`OIDC discovery: ${shownDiscovery} did not return a JSON object`);
  }
  const d = doc as Record<string, unknown>;
  if (d.issuer !== issuer) {
    throw new OidcFetchError(
      `OIDC discovery: the document at ${shownDiscovery} names issuer ${JSON.stringify(d.issuer)}, which does not match the configured issuer ${JSON.stringify(issuer)} (compared exactly); refusing it`,
    );
  }
  if (typeof d.jwks_uri !== "string") {
    throw new OidcFetchError(`OIDC discovery: the document at ${shownDiscovery} has no jwks_uri`);
  }
  try {
    const jwks = requireHttps(d.jwks_uri, "OIDC discovery: jwks_uri");
    if (o.pinJwksUri !== false) {
      const sameOrigin = jwks.origin === new URL(issuer).origin;
      // A listed hostname admits the default https port only (`URL.port` is "" for 443): the
      // same-origin rule is port-aware, so the allow-list must not be a way around it.
      const listed = (o.allowedJwksHosts ?? []).includes(jwks.hostname) && jwks.port === "";
      if (!sameOrigin && !listed) {
        throw new OidcFetchError(
          `OIDC discovery: jwks_uri ${jwks.origin} is not on the issuer's origin ${new URL(issuer).origin}; list its hostname in auth.oidc.allowedJwksHosts (default https port 443 only) or set auth.oidc.jwksUri if the identity provider really serves its keys from there`,
        );
      }
    }
  } catch (e) {
    throw new OidcFetchError(
      `OIDC discovery: the document at ${shownDiscovery} has an unusable jwks_uri: ${(e as Error).message}`,
    );
  }
  return { issuer, jwksUri: d.jwks_uri, document: d };
}
