// The one place a request's client address is decided. Every per-source limit (client-metadata
// lookups, passkey sign-in, authorize admission, registration, password-login failures) takes the
// address from here, so a rule changed here changes all of them.
//
// The address is the TCP peer, unless the peer is a proxy the operator listed in
// `transports.http.trustedProxies`: then it is the client that proxy forwarded, read from the header
// `transports.http.forwardedHeader` names. A header from any other peer is whatever the client wrote
// and is never read. A peer that is loopback (a reverse proxy or tunnel on the same host that was not
// listed) or unknown stays `undefined`: the shared "unattributed" source.
import {
  formatIpAddress,
  type IpCidr,
  ipInCidr,
  parseForwardedHop,
  parseIpAddress,
  parseIpCidr,
} from "@the-40-thieves/obsidian-tc-shared";
import type { Context } from "hono";

export type ForwardedHeader = "x-forwarded-for" | "cf-connecting-ip";

export interface ClientIpPolicy {
  /** Addresses and CIDR blocks of the proxies whose forwarded header is believed. Default: none. */
  trustedProxies?: readonly string[] | undefined;
  /** The header the client address is read from, for a trusted peer. Default: `x-forwarded-for`. */
  forwardedHeader?: ForwardedHeader | undefined;
}

const LOOPBACK_V4 = parseIpCidr("127.0.0.0/8") as IpCidr;
const LOOPBACK_V6 = parseIpAddress("::1");

const isLoopback = (addr: bigint): boolean => ipInCidr(addr, LOOPBACK_V4) || addr === LOOPBACK_V6;

const LOW_64_BITS = (1n << 64n) - 1n;

/**
 * The address a per-source limit keys on. An IPv4 client is itself. An IPv6 client is its /64 (the
 * network address, lower 64 bits zeroed): a host holds a whole /64 and can rotate within it for free,
 * so every limiter counts the /64 as one source, as the metadata-document and registration limits
 * already did. Logs show that network address.
 */
function sourceAddress(addr: bigint): string {
  return formatIpAddress(addr >> 32n === 0xffffn ? addr : addr & ~LOW_64_BITS);
}

/** The TCP peer of the request, or undefined when the runtime does not say. */
function peerOf(c: Context): bigint | undefined {
  const env = c.env as
    | {
        incoming?: { socket?: { remoteAddress?: string } };
        requestIP?: (req: Request) => { address?: string } | null;
      }
    | undefined;
  let addr = env?.incoming?.socket?.remoteAddress;
  if (addr === undefined && typeof env?.requestIP === "function") {
    addr = env.requestIP(c.req.raw)?.address;
  }
  if (!addr) return undefined;
  // A link-local peer may carry a zone id (fe80::1%eth0); it names the interface, not the host.
  return parseIpAddress(addr.replace(/%.*$/, ""));
}

/**
 * Build the client-address function for a policy. With no trusted proxy it is the TCP peer alone.
 * A malformed `trustedProxies` entry throws: a dropped entry would silently stop attributing clients.
 */
export function createClientIpResolver(
  policy: ClientIpPolicy = {},
): (c: Context) => string | undefined {
  const trusted = (policy.trustedProxies ?? []).map((entry): IpCidr => {
    const cidr = parseIpCidr(entry);
    if (cidr === undefined) {
      throw new Error(
        `trusted proxy ${JSON.stringify(entry)} is not an IP address or CIDR block (a name, a wildcard and a /0 prefix are refused)`,
      );
    }
    return cidr;
  });
  const isTrusted = (addr: bigint): boolean => trusted.some((cidr) => ipInCidr(addr, cidr));
  const header = policy.forwardedHeader ?? "x-forwarded-for";

  /** The client a trusted proxy forwarded, or undefined when the header does not say (use the peer). */
  const forwarded = (c: Context): bigint | undefined => {
    const raw = c.req.raw.headers.get(header);
    if (raw === null) return undefined;
    if (header === "cf-connecting-ip") {
      // Cloudflare sets one value; a list or anything else is not its header.
      return parseIpAddress(raw.trim());
    }
    // Walk from the right: each trusted proxy appended the address it saw, so the first hop that is
    // not a proxy of ours is the client, and everything left of it is whatever the client wrote.
    const hops = raw.split(",");
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = parseForwardedHop(hops[i] ?? "");
      // An unreadable hop on the trusted side breaks the chain: do not guess past it.
      if (hop === undefined) return undefined;
      if (!isTrusted(hop)) return hop;
    }
    return undefined;
  };

  return (c) => {
    const peer = peerOf(c);
    if (peer === undefined) return undefined;
    const client = (trusted.length > 0 && isTrusted(peer) ? forwarded(c) : undefined) ?? peer;
    return isLoopback(client) ? undefined : sourceAddress(client);
  };
}

/**
 * The address of the TCP peer, or undefined when it is not informative: unknown, or loopback (a
 * reverse proxy or tunnel on the same host, where every client looks like one address). Never reads
 * a forwarded header: for that, build a resolver with the operator's trusted proxies.
 */
export const socketClientIp: (c: Context) => string | undefined = createClientIpResolver();
