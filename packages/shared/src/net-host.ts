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

// Minimal ambient shape for the runtime `URL` global's constructor, read off `globalThis` rather
// than the bare `URL` identifier: this package carries no DOM/Node lib (see the module header),
// so the real `lib.dom` `URL` type isn't visible to it, and `typeof URL` would fail to compile —
// there is no declared name `URL` for `typeof` to check. `globalThis` itself is plain ES2020+.
interface MinimalUrl {
  protocol: string;
  hostname: string;
}
type MinimalUrlCtor = new (input: string) => MinimalUrl;

// THE-1084 review round 1, finding 1: parses with the RUNTIME `URL` class when one exists, which
// canonicalizes non-canonical-but-valid forms exactly as `new URL()`/`fetch` will before the
// request actually goes out ("http:evil.example/path" -> scheme "http", host "evil.example" —
// verified against Node/Bun). A hand-rolled `://`-requiring regex used to be the only parser here
// and rejected that form as unparseable; the caller then treated "unparseable" as "not remote
// http" and let it through with allowPlainHttp still false. The regex below is kept ONLY as a
// fallback for a runtime with no global URL (never Node or Bun in practice) and requires a literal
// `://`, same as before. Either path treats anything it cannot confidently parse as `null` —
// fail CLOSED, never open, on a classifier a security decision reads.
function parseJudgeBaseUrl(u: string): { scheme: string; host: string } | null {
  const UrlCtor = (globalThis as { URL?: MinimalUrlCtor }).URL;
  if (typeof UrlCtor === "function") {
    try {
      const parsed = new UrlCtor(u);
      return { scheme: parsed.protocol.replace(/:$/, "").toLowerCase(), host: parsed.hostname };
    } catch {
      return null;
    }
  }
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^:/?#]+)(?::\d+)?(?:[/?#]|$)/.exec(u);
  const scheme = m?.[1];
  const host = m?.[2];
  if (!scheme || !host) return null;
  return { scheme: scheme.toLowerCase(), host };
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
 *  path, the query, or any userinfo, only `URL.hostname` (or its regex-fallback equivalent).
 *  Returns undefined for a URL classify would call "invalid" (nothing safe to name). */
export function judgeBaseUrlHost(u: string): string | undefined {
  return parseJudgeBaseUrl(u)?.host;
}
