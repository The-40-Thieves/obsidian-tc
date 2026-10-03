// The outbound policy for a plain http:// request that carries a bearer key and vault text.
//
// A non-loopback http:// URL is sent only when BOTH hold:
//   1. its exact hostname is in the caller's `plainHttpHosts` (case-insensitive, punycode-normalized,
//      no wildcards — the deprecated `allowPlainHttp` flag maps to "this baseUrl's own host"), and
//   2. at connect time, every address that host resolves to is loopback, RFC1918 or IPv6
//      unique-local (isPrivateNetworkAddress; link-local is excluded: 169.254.169.254 is the cloud
//      metadata service), or, because the host IS listed, the Tailscale / CGNAT range 100.64/10
//      (isListedOnlyPrivateAddress: listing a host is the operator's statement that it is a tailnet
//      peer, whose WireGuard link is encrypted; an unlisted host never gets this range). A host
//      that resolves to anything else is refused even when it is listed: listing a name asserts the
//      operator trusts the NAME, not whatever DNS says today.
// The request then connects to the address that was checked, with the original Host header, so a
// second DNS answer cannot swap a public address in between the check and the send (rebinding).
// Every refusal is fail-closed and happens before a socket exists: no fallback, nothing sent.
//
// A loopback http:// URL needs no host list, but it takes the SAME direct transport: connected to
// a loopback address (a literal, or a name whose every answer is loopback), no agent, no proxy,
// redirects refused. It must never reach the global fetch: Bun's honours HTTP_PROXY / http_proxy /
// ALL_PROXY, and a proxy in the environment would receive the bearer key and the vault text while
// the loopback service got nothing. Every plain-http request is therefore sent from this module.
//
// One compatibility mode, `allowUnlistedPrivate`, exists for the provider clients (see
// gateway/provider-fetch.ts): before the policy existed any http:// provider URL worked, so a host
// that is NOT listed but resolves only to private addresses is still sent to, and reported through
// `onUnlistedPrivate` (a deprecation, removed at the next major). Everything else about the check is
// unchanged: a public, link-local or metadata address is refused whether the host is listed or not.
//
// Only https:// passes through to the ordinary fetch, which DOES honour a proxy variable. That is
// deliberate: an https request through a proxy is a CONNECT tunnel, so the proxy sees the host and
// port but cannot read the key or the body, and operators behind a mandatory egress proxy need
// it. It is called with `redirect: "manual"` and a 3xx answer is REFUSED, exactly as on the http
// leg: the runtime's default follows a 307/308 and replays the POST body (key and vault text) to a
// Location nobody checked against this policy. node:http is used for the plain-http leg because it is the one client API that Node and Bun
// both honor a pinned `host` + explicit Host header on (and neither applies proxy variables to);
// undici's `dispatcher` option is Node-only. node:http never follows redirects, which is what is
// wanted here: a 3xx from a vetted host must not be able to bounce the request to an unchecked
// address.
import { lookup } from "node:dns/promises";
import http from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
  isListedOnlyPrivateAddress,
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

/** Thrown when the policy refuses an outbound request: a plain-http host or address that fails the
 *  policy, or a redirect from any scheme. The message names the host and, where it applies, the
 *  offending address; it never carries the key, a path, a query or a redirect target. */
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
  /** The exact-host allow-list. A function is read on every request, so one long-lived fetch
   *  follows a config that is loaded after the client is built. */
  plainHttpHosts: readonly string[] | (() => readonly string[]);
  resolveHost?: ResolveHost | undefined;
  /** DEPRECATED compatibility, removed at the next major release: send to a non-loopback host that
   *  is not listed when every address it resolves to is private. Default false (judge clients). */
  allowUnlistedPrivate?: boolean | undefined;
  /** Called once per request that took the `allowUnlistedPrivate` path, with the checked address. */
  onUnlistedPrivate?: ((info: { host: string; address: string }) => void) | undefined;
}

const hostsOf = (h: PlainHttpPolicyOptions["plainHttpHosts"]): readonly string[] =>
  typeof h === "function" ? h() : h;

/** True for an http:// URL, loopback or not: every one is sent by this module, never by the global
 *  fetch (see the header). Only the target check differs. */
export function isPlainHttp(url: URL): boolean {
  return url.protocol === "http:";
}

/**
 * The ONE loopback address to connect to for a loopback http:// URL. No host list applies. An IP
 * literal is its own answer; `localhost` (RFC 6761) is resolved and every answer must be loopback,
 * and when the resolver gives nothing it means 127.0.0.1.
 * @throws PlainHttpRefusedError when any resolved address is not loopback.
 */
export async function resolveLoopbackTarget(
  url: URL,
  resolveHost: ResolveHost | undefined,
): Promise<ResolvedAddress> {
  const bare = normalizeHostForBind(url.hostname);
  const literalFamily = isIP(bare);
  if (literalFamily === 4 || literalFamily === 6) return { address: bare, family: literalFamily };
  const addresses = await (resolveHost ?? defaultResolveHost)(bare).catch(() => []);
  const bad = addresses.find((a) => !isLoopbackHost(a.address));
  if (bad !== undefined) {
    throw new PlainHttpRefusedError(
      `plain http to ${url.hostname} refused: it resolves to ${bad.address}, which is not a loopback address`,
    );
  }
  return addresses[0] ?? { address: "127.0.0.1", family: 4 };
}

/**
 * Check `url` against the policy and return the ONE address to connect to.
 * @throws PlainHttpRefusedError when the host is unlisted (unless `allowUnlistedPrivate`), does not
 *  resolve, or any resolved address is not private.
 */
export async function resolvePlainHttpTarget(
  url: URL,
  opts: PlainHttpPolicyOptions,
): Promise<ResolvedAddress> {
  const host = url.hostname;
  const listed = isPlainHttpHostListed(host, hostsOf(opts.plainHttpHosts));
  if (!listed && opts.allowUnlistedPrivate !== true) {
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
  // The tailnet/CGNAT range counts only for a LISTED host: the unlisted-private compatibility path
  // below never admits it. Every resolved address must pass.
  const bad = addresses.find(
    (a) =>
      !(isPrivateNetworkAddress(a.address) || (listed && isListedOnlyPrivateAddress(a.address))),
  );
  if (bad !== undefined) {
    const tailnetHint =
      !listed && isListedOnlyPrivateAddress(bad.address)
        ? `; a tailnet (100.64/10) host must be listed in plainHttpHosts, and only if it really is a tailnet peer`
        : "";
    throw new PlainHttpRefusedError(
      `plain http to ${host} refused: it resolves to ${bad.address}, which is not a private address (loopback, 10/8, 172.16/12, 192.168/16, fc00::/7${listed ? ", or a listed tailnet host in 100.64/10" : ""})${tailnetHint}`,
    );
  }
  if (!listed) opts.onUnlistedPrivate?.({ host, address: first.address });
  return first;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** The refusal for an https answer that redirects. Nothing is sent to the Location target. */
function httpsRedirectRefused(host: string, status: number): PlainHttpRefusedError {
  return new PlainHttpRefusedError(
    `https to ${host} refused: it answered with a redirect (HTTP ${status}); redirects are not followed`,
  );
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/** The address to hand to the socket. An IPv4-mapped IPv6 literal (`::ffff:7f00:1`, or the dotted
 *  `::ffff:127.0.0.1`) is connected as the IPv4 address it spells: the policy judged it as that
 *  address, and Windows has no route for the mapped form (ECONNREFUSED). */
function connectAddress(address: string): string {
  const m = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (m === null) return address;
  if (m[1] !== undefined) return m[1];
  const hi = Number.parseInt(m[2] as string, 16);
  const lo = Number.parseInt(m[3] as string, 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
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
      host: connectAddress(target.address),
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
  /** The transport for https:// requests only. Defaults to the global fetch, looked up per call so
   *  a test or instrumentation layer that replaces it is honored. */
  baseFetch?: typeof fetch | undefined;
}

/**
 * A `fetch` that enforces the plain-http policy above and sends https:// through `baseFetch`.
 * Request bodies must be a string, a Uint8Array or absent (every caller here sends JSON).
 */
export function createPlainHttpPolicyFetch(opts: PlainHttpPolicyFetchOptions): typeof fetch {
  const baseFetch = (...a: Parameters<typeof fetch>) => (opts.baseFetch ?? globalThis.fetch)(...a);
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    // Decide from the URL alone: building a Request here would consume a streamed body that the
    // pass-through leg still needs.
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!isPlainHttp(url)) {
      // Never let the runtime follow a redirect: it would replay the POST body to an unchecked
      // destination. `manual` hands the 3xx back (Node and Bun surface the real status; a runtime
      // that returns an opaque redirect is caught by its type), and it is refused here.
      const res = await baseFetch(input, { ...init, redirect: "manual" });
      const redirected =
        res.type === "opaqueredirect" ||
        (res.status >= 300 && res.status < 400 && res.headers.get("location") !== null);
      if (redirected) {
        void res.body?.cancel();
        throw httpsRedirectRefused(url.hostname, res.status);
      }
      return res;
    }
    const req = new Request(
      input as ConstructorParameters<typeof Request>[0],
      init as RequestInit | undefined,
    );
    req.signal.throwIfAborted();
    // Refuse before reading the body or opening anything.
    const target = isLoopbackHost(url.hostname)
      ? await resolveLoopbackTarget(url, opts.resolveHost)
      : await resolvePlainHttpTarget(url, opts);
    const body = req.body === null ? undefined : new Uint8Array(await req.arrayBuffer());
    return sendPinned(target, { url, method: req.method, headers: req.headers, body }, req.signal);
  }) as typeof fetch;
}
