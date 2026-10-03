// The outbound policy for a plain http:// request that carries a bearer key and vault text.
//
// A non-loopback http:// URL is sent only when BOTH hold:
//   1. its exact hostname is in the caller's `plainHttpHosts` (case-insensitive, punycode-normalized,
//      no wildcards — the deprecated `allowPlainHttp` flag maps to "this baseUrl's own host"), and
//   2. at connect time, every address that host resolves to is loopback, RFC1918 or IPv6
//      unique-local (isPrivateNetworkAddress; link-local is excluded: 169.254.169.254 is the cloud
//      metadata service). A host that resolves to anything else is
//      refused even when it is listed: listing a name asserts the operator trusts the NAME, not
//      whatever DNS says today.
// The request then connects to the address that was checked, with the original Host header, so a
// second DNS answer cannot swap a public address in between the check and the send (rebinding).
// Every refusal is fail-closed and happens before a socket exists: no fallback, nothing sent.
//
// https:// and loopback http:// URLs are not this module's business and pass straight through to
// the ordinary fetch. node:http is used for the plain-http leg because it is the one client API
// that Node and Bun both honor a pinned `host` + explicit Host header on; undici's `dispatcher`
// option is Node-only. node:http never follows redirects, which is what is wanted here: a 3xx from
// a vetted host must not be able to bounce the request to an address nobody checked.
import { lookup } from "node:dns/promises";
import http from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
  isLoopbackHost,
  isPlainHttpHostListed,
  isPrivateNetworkAddress,
  normalizeHostForBind,
} from "@the-40-thieves/obsidian-tc-shared";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to ALL of its addresses, in the resolver's order. The seam tests stub. */
export type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>;

/** Thrown when the policy refuses a plain-http request. The message names the host and, where it
 *  applies, the offending address; it never carries the key, a path or a query. */
export class PlainHttpRefusedError extends Error {
  readonly code = "EPLAINHTTP_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "PlainHttpRefusedError";
    Object.setPrototypeOf(this, PlainHttpRefusedError.prototype);
  }
}

export const defaultResolveHost: ResolveHost = async (hostname) => {
  const all = await lookup(hostname, { all: true, verbatim: true });
  return all.flatMap((a) =>
    a.family === 4 || a.family === 6 ? [{ address: a.address, family: a.family }] : [],
  );
};

export interface PlainHttpPolicyOptions {
  plainHttpHosts: readonly string[];
  resolveHost?: ResolveHost | undefined;
}

/** True for an http:// URL the policy governs: plain http on a host that is not loopback. */
export function isGovernedPlainHttp(url: URL): boolean {
  return url.protocol === "http:" && !isLoopbackHost(url.hostname);
}

/**
 * Check `url` against the policy and return the ONE address to connect to.
 * @throws PlainHttpRefusedError when the host is unlisted, does not resolve, or any resolved
 *  address is not private.
 */
export async function resolvePlainHttpTarget(
  url: URL,
  opts: PlainHttpPolicyOptions,
): Promise<ResolvedAddress> {
  const host = url.hostname;
  if (!isPlainHttpHostListed(host, opts.plainHttpHosts)) {
    throw new PlainHttpRefusedError(
      `plain http to ${host} refused: the host is not listed in plainHttpHosts (use https://, a loopback host, or list the exact hostname)`,
    );
  }
  const bare = normalizeHostForBind(host);
  const literalFamily = isIP(bare);
  // An IP literal is its own answer: no DNS, nothing to rebind.
  const addresses: ResolvedAddress[] =
    literalFamily === 4 || literalFamily === 6
      ? [{ address: bare, family: literalFamily }]
      : await (opts.resolveHost ?? defaultResolveHost)(bare).catch(() => []);
  const first = addresses[0];
  if (first === undefined) {
    throw new PlainHttpRefusedError(`plain http to ${host} refused: the host did not resolve`);
  }
  const bad = addresses.find((a) => !isPrivateNetworkAddress(a.address));
  if (bad !== undefined) {
    throw new PlainHttpRefusedError(
      `plain http to ${host} refused: it resolves to ${bad.address}, which is not a private address (loopback, 10/8, 172.16/12, 192.168/16, fc00::/7)`,
    );
  }
  return first;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

function sendPinned(
  target: ResolvedAddress,
  req: { url: URL; method: string; headers: Headers; body: Uint8Array | undefined },
  signal: AbortSignal,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    // The Host header is the ORIGINAL authority, never the pinned address.
    headers.host = req.url.host;
    if (headers["accept-encoding"] === undefined) headers["accept-encoding"] = "identity";
    if (req.body !== undefined) headers["content-length"] = String(req.body.byteLength);
    const out = http.request({
      host: target.address,
      port: req.url.port === "" ? 80 : Number(req.url.port),
      method: req.method,
      path: `${req.url.pathname}${req.url.search}`,
      headers,
      agent: false,
    });
    const onAbort = () => out.destroy(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);
    out.once("error", (e) => {
      done();
      reject(e);
    });
    out.once("response", (res) => {
      res.once("close", done);
      const h = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        h.append(res.rawHeaders[i] as string, res.rawHeaders[i + 1] as string);
      }
      const status = res.statusCode ?? 502;
      // Redirects are refused, never followed: the Location target was not checked against the
      // host list or the private-address rule, and nothing is sent to it.
      if (status >= 300 && status < 400 && res.headers.location !== undefined) {
        res.destroy();
        done();
        reject(
          new PlainHttpRefusedError(
            `plain http to ${req.url.hostname} refused: it answered with a redirect (HTTP ${status}); redirects are not followed`,
          ),
        );
        return;
      }
      const noBody = NULL_BODY_STATUS.has(status) || req.method === "HEAD";
      if (noBody) res.resume();
      resolve(
        new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
          status,
          statusText: res.statusMessage ?? "",
          headers: h,
        }),
      );
    });
    out.end(req.body);
  });
}

export interface PlainHttpPolicyFetchOptions extends PlainHttpPolicyOptions {
  /** The transport for https:// and loopback http:// requests. Defaults to the global fetch,
   *  looked up per call so a test or instrumentation layer that replaces it is honored. */
  baseFetch?: typeof fetch | undefined;
}

/**
 * A `fetch` that enforces the plain-http policy above and otherwise behaves like `baseFetch`.
 * Request bodies must be a string, a Uint8Array or absent (every caller here sends JSON).
 */
export function createPlainHttpPolicyFetch(opts: PlainHttpPolicyFetchOptions): typeof fetch {
  const plainHttpHosts = opts.plainHttpHosts;
  const baseFetch = (...a: Parameters<typeof fetch>) => (opts.baseFetch ?? globalThis.fetch)(...a);
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    // Decide from the URL alone: building a Request here would consume a streamed body that the
    // pass-through leg still needs.
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!isGovernedPlainHttp(url)) return baseFetch(input, init);
    const req = new Request(
      input as ConstructorParameters<typeof Request>[0],
      init as RequestInit | undefined,
    );
    req.signal.throwIfAborted();
    // Refuse before reading the body or opening anything.
    const target = await resolvePlainHttpTarget(url, {
      plainHttpHosts,
      resolveHost: opts.resolveHost,
    });
    const body = req.body === null ? undefined : new Uint8Array(await req.arrayBuffer());
    return sendPinned(target, { url, method: req.method, headers: req.headers, body }, req.signal);
  }) as typeof fetch;
}
