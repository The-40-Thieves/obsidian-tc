// Where the identity provider is allowed to be, for `auth.mode: "oidc"`. The issuer, the discovery
// document and the JWKS are fetched from a name an operator typed and a document a remote party
// wrote, so without this an IdP (or a compromised one) is a way to make the server GET internal
// addresses: cloud metadata, loopback services, the LAN. Every fetch resolves the host first and
// refuses when ANY address is not public, unless the operator opted in with `allowPrivateNetwork`.
//
// Limit, stated plainly: the check resolves, then `fetch` resolves again, so a DNS record that flips
// between the two can still slip through. Closing that needs the connection pinned to the checked
// address, which the runtime `fetch` does not offer. The window is per fetch and the response is
// still only ever read as a bounded JSON document.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  embeddedIpv4Addresses,
  isDisallowedLiteralHost,
  isLoopbackHost,
  normalizeHostForBind,
} from "@the-40-thieves/obsidian-tc-shared";

export interface IdpNetworkPolicy {
  /** Skip the public-address check (a self-hosted IdP on a LAN or loopback). Default false. */
  allowPrivateNetwork?: boolean;
  /** Test seam: the addresses a host resolves to. Defaults to the system resolver. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export const systemResolveHost = async (hostname: string): Promise<string[]> =>
  (await lookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

/** `::ffff:a.b.c.d` and `::ffff:hhhh:hhhh` back to dotted quad; anything else is returned as is. */
function unmapV4(h: string): string {
  if (!h.startsWith("::ffff:")) return h;
  const rest = h.slice("::ffff:".length);
  if (isIP(rest) === 4) return rest;
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (m?.[1] === undefined || m[2] === undefined) return h;
  const hi = Number.parseInt(m[1], 16);
  const lo = Number.parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * True for any address that is not a public unicast address: loopback, unspecified, RFC 1918,
 * carrier-grade NAT, link-local (169.254/16 is the cloud metadata address), unique-local,
 * multicast/reserved, benchmarking, cloud metadata, and the IPv6 forms that embed an IPv4 address
 * (IPv4-mapped, NAT64, and 6to4 / Teredo, whose embedded IPv4 is judged by this same function). An
 * unparseable string is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const h = unmapV4(normalizeHostForBind(address));
  const family = isIP(h);
  if (family === 0) return true;
  if (isLoopbackHost(h) || isDisallowedLiteralHost(h)) return true;
  // 6to4 (2002::/16) and Teredo (2001:0::/32) carry an IPv4 address: a tunnel prefix must not get
  // a blocked IPv4 past the check.
  if (embeddedIpv4Addresses(h).some(isBlockedAddress)) return true;
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = h.split(".").map(Number);
    return (
      a >= 224 || // multicast, reserved, broadcast
      (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)) // benchmarking
    );
  }
  return (
    h.startsWith("::") || // unspecified, loopback and the deprecated IPv4-compatible block
    h.startsWith("ff") || // multicast
    /^fe[c-f]/.test(h) || // deprecated site-local
    h.startsWith("64:ff9b:") // NAT64: embeds an IPv4 address we cannot vouch for
  );
}

/** Throws (with `what` and the offending address) unless `hostname` resolves only to public addresses. */
export async function assertPublicHost(
  hostname: string,
  policy: IdpNetworkPolicy,
  fail: (message: string, cause?: unknown) => Error,
  what: string,
): Promise<void> {
  if (policy.allowPrivateNetwork === true) return;
  const host = normalizeHostForBind(hostname);
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await (policy.resolveHost ?? systemResolveHost)(host);
    } catch (e) {
      throw fail(
        `${what}: ${host} could not be resolved (${e instanceof Error ? e.message : String(e)})`,
        e,
      );
    }
    if (addresses.length === 0) throw fail(`${what}: ${host} did not resolve to any address`);
  }
  const bad = addresses.find(isBlockedAddress);
  if (bad !== undefined) {
    throw fail(
      `${what}: ${host} resolves to ${bad}, which is not a public address (loopback, link-local, private or reserved); refusing to fetch it. Set auth.oidc.allowPrivateNetwork for an identity provider on a private network`,
    );
  }
}
