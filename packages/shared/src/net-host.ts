/**
 * Normalize a host string for binding and loopback comparison: trim, lowercase,
 * and strip a single surrounding pair of IPv6 brackets. Node's bind layer expects
 * the bare address ("::1"), not the bracketed URL form ("[::1]"), so the same
 * normalization must feed both the loopback check and the actual bind call.
 * Otherwise a bracketed host can clear the F2 safety gate yet fail to bind.
 */
export function normalizeHostForBind(host: string): string {
  return host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

// Strict dotted-quad IPv4 with every octet in 0-255. Kept dependency-free (no
// node:net) so this module stays usable from the isomorphic shared package.
// Rejects malformed values like "127.999.999.999" that a loose \d{1,3} regex
// would wrongly accept.
function isStrictIpv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * True only for genuine loopback hosts: "localhost", the IPv4 loopback block
 * 127.0.0.0/8 (octets validated), IPv6 "::1", and IPv4-mapped IPv6 loopback
 * "::ffff:127.x.x.x". "0.0.0.0", "::", and any LAN or public address are
 * intentionally NOT loopback (F2).
 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHostForBind(host);
  if (h === "localhost" || h === "::1") return true;
  if (isStrictIpv4(h)) return h.startsWith("127.");
  if (h.startsWith("::ffff:")) {
    const v4 = h.slice("::ffff:".length);
    return isStrictIpv4(v4) && v4.startsWith("127.");
  }
  return false;
}
