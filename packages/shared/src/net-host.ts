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

// THE-1084 review round 2, finding 2: `new URL("http://[::ffff:127.0.0.1]").hostname` canonicalizes
// to the COMPRESSED HEX form "[::ffff:7f00:1]", not the dotted-quad spelling below — so a caller
// that only recognized "::ffff:<dotted>" missed exactly the address the runtime URL parser (and
// every real caller building this string through it) actually produces. `rest` is the two
// colon-separated hex groups after "::ffff:" (each 1-4 hex digits, zero-padding optional); this
// decodes them back to the four bytes they encode. Returns null for anything that isn't that shape.
function ipv4MappedHexToDotted(rest: string): string | null {
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  const g1 = m?.[1];
  const g2 = m?.[2];
  if (!g1 || !g2) return null;
  const hi = Number.parseInt(g1, 16);
  const lo = Number.parseInt(g2, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * True only for genuine loopback hosts: "localhost", the IPv4 loopback block
 * 127.0.0.0/8 (octets validated), IPv6 "::1", and IPv4-mapped IPv6 loopback
 * "::ffff:127.x.x.x" in EITHER its dotted-quad spelling or the compressed-hex
 * spelling ("::ffff:7f00:1") a real URL parser canonicalizes it to. "0.0.0.0",
 * "::", and any LAN or public address are intentionally NOT loopback (F2).
 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHostForBind(host);
  if (h === "localhost" || h === "::1") return true;
  if (isStrictIpv4(h)) return h.startsWith("127.");
  if (h.startsWith("::ffff:")) {
    const rest = h.slice("::ffff:".length);
    const dotted = isStrictIpv4(rest) ? rest : ipv4MappedHexToDotted(rest);
    return dotted?.startsWith("127.") ?? false;
  }
  return false;
}

function ipv4OctetsOf(h: string): [number, number, number, number] | null {
  if (!isStrictIpv4(h)) return null;
  const parts = h.split(".").map(Number);
  return parts as [number, number, number, number];
}

// THE-1125 (security-review follow-up) — private/reserved IPv4 ranges a telemetry endpoint must
// never be allowed to name literally: RFC1918 private space (10/8, 172.16/12, 192.168/16),
// RFC3927 link-local (169.254/16 — this is ALSO the cloud metadata address, 169.254.169.254, on
// every major cloud provider), RFC6598 carrier-grade NAT (100.64/10), and 0/8 ("this network").
// 127/8 (loopback) is deliberately excluded here — it is checked and ALLOWED separately by
// isLoopbackHost.
function isDisallowedPrivateIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// THE-1125 — the IPv6 counterparts: "::" (unspecified), fc00::/7 (unique-local, RFC4193 —
// fd00::/8 in practice, the IPv6 analogue of RFC1918), fe80::/10 (link-local). "::1" (loopback) is
// deliberately excluded — allowed separately by isLoopbackHost. `h` must already be
// normalizeHostForBind'd (lowercase, unbracketed).
function isDisallowedPrivateIpv6(h: string): boolean {
  if (h === "::") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(h)) return true;
  return false;
}

/**
 * True when `host` is a LITERAL IP address (v4, v6, or an IPv4-mapped IPv6 form) in a private,
 * link-local, carrier-grade-NAT, unspecified, or cloud-metadata range. Loopback is NOT included
 * here (see isLoopbackHost) — it is the one such range a config is allowed to name.
 *
 * Deliberately does NOT resolve DNS: a hostname that happens to RESOLVE to one of these ranges at
 * request time is out of scope by design (this is an operator-configured value, documented as
 * such — resolving it here would need a network call inside config validation, and the resolved
 * address could differ at send time anyway). This function only ever looks at the literal text of
 * the host, exactly as `new URL(...).hostname` reports it.
 */
export function isDisallowedLiteralHost(host: string): boolean {
  const h = normalizeHostForBind(host);
  const direct = ipv4OctetsOf(h);
  if (direct) return direct[0] !== 127 && isDisallowedPrivateIpv4(direct);
  if (h.startsWith("::ffff:")) {
    const rest = h.slice("::ffff:".length);
    const dotted = ipv4OctetsOf(rest) ? rest : ipv4MappedHexToDotted(rest);
    const mapped = dotted !== null ? ipv4OctetsOf(dotted) : null;
    if (!mapped) return false; // unparseable — not this function's job to flag.
    return mapped[0] !== 127 && isDisallowedPrivateIpv4(mapped);
  }
  if (h.includes(":")) return isDisallowedPrivateIpv6(h); // a bare IPv6 literal.
  return false; // a hostname, not a literal IP — see the "does not resolve DNS" note above.
}

// Minimal ambient shape for the runtime `URL` global's constructor, read off `globalThis` rather
// than the bare `URL` identifier: this package carries no DOM/Node lib (see the module header),
// so the real `lib.dom` `URL` type isn't visible to it, and `typeof URL` would fail to compile —
// there is no declared name `URL` for `typeof` to check. `globalThis` itself is plain ES2020+.
interface MinimalUrl {
  protocol: string;
  hostname: string;
}
type MinimalUrlCtor = new (input: string) => MinimalUrl;

// THE-1084 review round 1, finding 1: parses with the RUNTIME `URL` class, which canonicalizes
// non-canonical-but-valid forms exactly as `new URL()`/`fetch` will before the request actually
// goes out ("http:evil.example/path" -> scheme "http", host "evil.example" — verified against
// Node/Bun). A hand-rolled `://`-requiring regex used to be the only parser here and rejected that
// form as unparseable; the caller then treated "unparseable" as "not remote http" and let it
// through with allowPlainHttp still false.
//
// THE-1084 review round 2, finding 1: an EARLIER version of this function kept that same regex as
// a fallback for "no global URL" — but the regex is permissive in ways the WHATWG parser is not
// (it accepted "https://exa mple", "https://%zz", and "http://localhost:99999", all of which
// `new URL()` rejects), so the fallback could pass a URL the real HTTP client would refuse, or
// classify one with a host the client will never actually reach. Bun and Node both always have a
// global `URL`, so there is no real runtime to fall back FOR — removed entirely. When
// `globalThis.URL` is not a function, this returns `null` (parseJudgeBaseUrl) and the classifier
// answers "invalid": fail CLOSED, never open, on a classifier a security decision reads.
function parseJudgeBaseUrl(u: string): { scheme: string; host: string } | null {
  const UrlCtor = (globalThis as { URL?: MinimalUrlCtor }).URL;
  if (typeof UrlCtor !== "function") return null;
  try {
    const parsed = new UrlCtor(u);
    return { scheme: parsed.protocol.replace(/:$/, "").toLowerCase(), host: parsed.hostname };
  } catch {
    return null;
  }
}

/** THE-1084: how `experiential.citationInfer.judge.baseUrl` (and any URL with the same shape of
 *  requirement) is treated by the https-unless-loopback-unless-opted-in rule, centralized so the
 *  schema refine, the doctor warning, and the runtime builder's own enforcement can never drift
 *  from each other or from three separately hand-rolled parsers (THE-1084 review round 1, finding
 *  1 — that drift is exactly what let a non-canonical URL bypass the schema check).
 *
 *  - `"https"` — always fine, any host.
 *  - `"http-loopback"` — http:// on a genuine loopback host (localhost/127.0.0.1/[::1] etc) — the
 *    existing local test/dev carve-out, unconditional, no flag needed.
 *  - `"http-remote"` — http:// on any other host — fine ONLY when the caller has separately
 *    confirmed `allowPlainHttp === true`; this function does not read that flag.
 *  - `"invalid"` — the URL could not be parsed, OR its scheme is neither https nor http (ftp:,
 *    file:, ...). Review round 1 finding 3: the opt-in widens exactly http:// on a non-loopback
 *    host, never "any non-https scheme" — an unsupported scheme is invalid regardless of
 *    allowPlainHttp, same as an unparseable one.
 */
export function classifyJudgeBaseUrl(
  u: string,
): "https" | "http-loopback" | "http-remote" | "invalid" {
  const parsed = parseJudgeBaseUrl(u);
  if (!parsed?.host) return "invalid";
  if (parsed.scheme === "https") return "https";
  if (parsed.scheme !== "http") return "invalid";
  return isLoopbackHost(parsed.host) ? "http-loopback" : "http-remote";
}

/** The host `classifyJudgeBaseUrl` parsed `u` as, for a warning message — never the key, the
 *  path, the query, or any userinfo, only `URL.hostname`.
 *  Returns undefined for a URL classify would call "invalid" (nothing safe to name). */
export function judgeBaseUrlHost(u: string): string | undefined {
  return parseJudgeBaseUrl(u)?.host;
}
