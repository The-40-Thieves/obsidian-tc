// IP address and CIDR parsing, dependency-free (no node:net) so the config schema can validate
// `transports.http.trustedProxies` and the server can match a peer against it with the same code.
//
// Every address is held as one 128-bit integer. An IPv4 address is stored IPv4-mapped
// (::ffff:a.b.c.d), so `10.0.0.1` and `::ffff:10.0.0.1` are the same number and a mapped peer
// (what a dual-stack socket reports for an IPv4 client) matches an IPv4 entry. Parsing is strict:
// anything that is not unambiguously an address (leading-zero octets that some resolvers read as
// octal, shorthand like `127.1`, a zone id, trailing junk) is refused rather than guessed at.

const MAPPED_PREFIX = 0xffffn << 32n;
const ALL_BITS = (1n << 128n) - 1n;

function parseIpv4(s: string): bigint | undefined {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(s);
  if (!m) return undefined;
  let v = 0n;
  for (const part of m.slice(1)) {
    const octet = Number(part);
    if (octet > 255) return undefined;
    v = (v << 8n) | BigInt(octet);
  }
  return v;
}

function parseIpv6(s: string): bigint | undefined {
  let text = s;
  // An embedded dotted quad (::ffff:1.2.3.4) is the last 32 bits, written as two groups.
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groupsOf = (h: string): string[] => (h === "" ? [] : h.split(":"));
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;
  // "::" stands for at least one group of zeros; without it all eight must be written.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return undefined;
    v = (v << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return v;
}

/**
 * A bare IPv4 or IPv6 address (no port, brackets, zone id or padding) as a 128-bit number, IPv4
 * stored IPv4-mapped. Undefined for anything else.
 */
export function parseIpAddress(text: string): bigint | undefined {
  if (text.includes(":")) return parseIpv6(text);
  const v4 = parseIpv4(text);
  return v4 === undefined ? undefined : MAPPED_PREFIX | v4;
}

/** The canonical text of a parsed address: dotted for IPv4 (mapped or not), else eight lowercase groups. */
export function formatIpAddress(addr: bigint): string {
  if (addr >> 32n === 0xffffn) {
    const n = Number(addr & 0xffffffffn);
    return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
  }
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((addr >> shift) & 0xffffn).toString(16));
  }
  return groups.join(":");
}

/**
 * The client address one hop of an `X-Forwarded-For` list names: `1.2.3.4`, `1.2.3.4:5678`,
 * `2001:db8::1`, `[2001:db8::1]` or `[2001:db8::1]:5678`, with surrounding whitespace and one pair of
 * double quotes tolerated. Undefined for `unknown`, `_obfuscated`, a bad port, or anything else.
 */
export function parseForwardedHop(token: string): bigint | undefined {
  let t = token.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).trim();
  const port = /^\d{1,5}$/;
  const validPort = (p: string): boolean => port.test(p) && Number(p) <= 65535;
  if (t.startsWith("[")) {
    const close = t.indexOf("]");
    if (close < 0) return undefined;
    const rest = t.slice(close + 1);
    if (rest !== "" && !(rest.startsWith(":") && validPort(rest.slice(1)))) return undefined;
    const inner = t.slice(1, close);
    return inner.includes(":") ? parseIpv6(inner) : undefined;
  }
  const colons = t.split(":").length - 1;
  if (colons === 1 && t.includes(".")) {
    const [host = "", p = ""] = t.split(":");
    return validPort(p) ? parseIpAddress(host) : undefined;
  }
  return parseIpAddress(t);
}

/** A CIDR block over the 128-bit space: `bits` leading bits of `base` are significant. */
export interface IpCidr {
  base: bigint;
  bits: number;
}

/**
 * `ip` (a single host) or `ip/prefix`. An IPv4 prefix counts in IPv4 bits (`10.0.0.0/8`); an IPv6
 * one in IPv6 bits. A prefix of 0 is refused: it would name every address, and a trusted-proxy list
 * that trusts everyone is the spoofable setup this exists to prevent.
 */
export function parseIpCidr(text: string): IpCidr | undefined {
  const slash = text.indexOf("/");
  const addrText = slash < 0 ? text : text.slice(0, slash);
  const addr = parseIpAddress(addrText);
  if (addr === undefined) return undefined;
  const isV4Text = !addrText.includes(":");
  if (slash < 0) return { base: addr, bits: 128 };
  const prefixText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return undefined;
  const prefix = Number(prefixText);
  if (prefix < 1 || prefix > (isV4Text ? 32 : 128)) return undefined;
  const bits = isV4Text ? prefix + 96 : prefix;
  return { base: addr, bits };
}

/** True when `addr` falls inside `cidr`. */
export function ipInCidr(addr: bigint, cidr: IpCidr): boolean {
  const hostBits = BigInt(128 - cidr.bits);
  const mask = (ALL_BITS >> hostBits) << hostBits;
  return (addr & mask) === (cidr.base & mask);
}
