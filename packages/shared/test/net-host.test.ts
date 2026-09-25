import { describe, expect, it } from "vitest";
import {
  classifyJudgeBaseUrl,
  isDisallowedLiteralHost,
  isLoopbackHost,
  judgeBaseUrlHost,
  normalizeHostForBind,
} from "../src/net-host";

describe("normalizeHostForBind", () => {
  it("trims, lowercases, and strips one surrounding bracket pair", () => {
    expect(normalizeHostForBind("  [::1]  ")).toBe("::1");
    expect(normalizeHostForBind("[127.0.0.1]")).toBe("127.0.0.1");
    expect(normalizeHostForBind(" LOCALHOST ")).toBe("localhost");
    expect(normalizeHostForBind("0.0.0.0")).toBe("0.0.0.0");
  });
});

describe("isLoopbackHost", () => {
  it("accepts loopback forms, including bracketed and padded", () => {
    for (const h of [
      "127.0.0.1",
      "127.0.0.5",
      "127.255.255.254",
      "::1",
      "[::1]",
      " [::1] ",
      "[127.0.0.1]",
      "localhost",
      "LOCALHOST",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("rejects non-loopback and malformed hosts", () => {
    for (const h of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "10.0.0.1",
      "example.com",
      "127.999.999.999",
      "1270.0.0.1",
      "127.0.0",
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  // THE-1084 review round 2, finding 2: `new URL("http://[::ffff:127.0.0.1]").hostname`
  // canonicalizes to the COMPRESSED HEX form, not the dotted-quad spelling — a real caller's URL
  // parser produces this spelling, not the one already covered above.
  it("accepts the compressed-hex IPv4-mapped IPv6 loopback spelling too", () => {
    for (const h of ["::ffff:7f00:1", "[::ffff:7f00:1]", "::FFFF:7F00:1"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    // A non-loopback IPv4-mapped address in the same hex shape must still be rejected — this is
    // not "any ::ffff:x:y passes", only the ones that decode to 127.0.0.0/8.
    expect(isLoopbackHost("::ffff:c0a8:10a")).toBe(false); // 192.168.1.10
  });
});

// THE-1084 review round 1: the single classifier the citationInfer.judge.baseUrl schema refine,
// the doctor warning, and the runtime builder all now call, so they can never classify one URL
// three different ways again.
describe("classifyJudgeBaseUrl", () => {
  it("https:// is always fine, any host", () => {
    expect(classifyJudgeBaseUrl("https://api.typesafe.ai")).toBe("https");
    expect(classifyJudgeBaseUrl("https://127.0.0.1")).toBe("https");
    expect(classifyJudgeBaseUrl("https://evil.example/path?x=1")).toBe("https");
  });

  it("http:// on a genuine loopback host is http-loopback", () => {
    for (const u of ["http://localhost:4001", "http://127.0.0.1:8000", "http://[::1]:9"]) {
      expect(classifyJudgeBaseUrl(u)).toBe("http-loopback");
    }
  });

  it("http:// on any other host is http-remote", () => {
    expect(classifyJudgeBaseUrl("http://litellm:4000/typesafe")).toBe("http-remote");
    expect(classifyJudgeBaseUrl("http://ts.example.com")).toBe("http-remote");
    expect(classifyJudgeBaseUrl("http://192.168.1.10")).toBe("http-remote");
  });

  // THE-1084 review round 1, finding 1: the exact bug the old `://`-requiring regex introduced —
  // Zod's `.url()` (and the runtime `URL`/fetch that actually sends the request) accept these
  // non-canonical forms and normalize them to a canonical `http://<host>/...`, so classification
  // must too, rather than reporting "invalid" and letting a caller treat that as "not remote".
  it("non-canonical http: forms (no literal '://') classify by their WHATWG-normalized host", () => {
    expect(classifyJudgeBaseUrl("http:evil.example/path")).toBe("http-remote");
    expect(classifyJudgeBaseUrl("http:/evil.example/path")).toBe("http-remote");
    expect(classifyJudgeBaseUrl("http:\\\\evil.example/path")).toBe("http-remote");
    // The loopback carve-out still applies to a non-canonical form naming a loopback host.
    expect(classifyJudgeBaseUrl("http:localhost/path")).toBe("http-loopback");
  });

  // THE-1084 review round 1, finding 3: the opt-in widens exactly http:// on a non-loopback host,
  // never "any non-https scheme" — ftp:/file:/etc are invalid regardless of allowPlainHttp.
  it("a scheme other than https/http is invalid, not merely 'not http'", () => {
    expect(classifyJudgeBaseUrl("ftp://host")).toBe("invalid");
    expect(classifyJudgeBaseUrl("file:///etc/passwd")).toBe("invalid");
  });

  it("an unparseable string is invalid — fails CLOSED, never open", () => {
    expect(classifyJudgeBaseUrl("not a url at all")).toBe("invalid");
    expect(classifyJudgeBaseUrl("")).toBe("invalid");
  });

  // THE-1084 review round 2, finding 2: through the classifier, not just isLoopbackHost directly —
  // this is the actual shape a `judge.baseUrl` of "http://[::ffff:127.0.0.1]" resolves to.
  it("classifies http://[::ffff:127.0.0.1] as http-loopback, via the parser's own canonicalization", () => {
    expect(classifyJudgeBaseUrl("http://[::ffff:127.0.0.1]")).toBe("http-loopback");
  });

  // THE-1084 review round 2, finding 1: no regex fallback remains — when the runtime has no
  // global `URL` (never true for Bun/Node, but the classifier must still fail closed if it were),
  // every URL is "invalid", including an otherwise-ordinary https:// one.
  it('classifies everything as "invalid" when globalThis.URL is not a function', () => {
    const g = globalThis as { URL?: unknown };
    const original = g.URL;
    try {
      g.URL = undefined;
      expect(classifyJudgeBaseUrl("https://api.typesafe.ai")).toBe("invalid");
    } finally {
      g.URL = original;
    }
  });

  // THE-1084 review round 2 "cheap direct assertions" — each stated and asserted deliberately
  // rather than left implicit in the non-canonical-form tests above.
  describe("cheap direct assertions (THE-1084 review round 2)", () => {
    it("an uppercase HTTPS:// scheme still classifies as https", () => {
      expect(classifyJudgeBaseUrl("HTTPS://EXAMPLE.com")).toBe("https");
    });

    it("an uppercase HTTP:// scheme on a non-loopback host still classifies as http-remote", () => {
      expect(classifyJudgeBaseUrl("HTTP://EXAMPLE.com")).toBe("http-remote");
    });

    it("surrounding whitespace is trimmed by the URL parser itself — still classifies normally", () => {
      expect(classifyJudgeBaseUrl("  https://example.com  ")).toBe("https");
    });

    it("a single-slash http:/one-slash form still resolves a host and classifies as http-remote", () => {
      expect(classifyJudgeBaseUrl("http:/one-slash")).toBe("http-remote");
    });

    // The WHATWG parser canonicalizes shorthand IPv4 "127.1" to "127.0.0.1" (verified against
    // Node/Bun) — so this DOES count as loopback, via that canonicalization, not despite it.
    it('"127.1" canonicalizes to 127.0.0.1 and counts as loopback', () => {
      expect(classifyJudgeBaseUrl("http://127.1")).toBe("http-loopback");
    });

    // "0.0.0.0" is never canonicalized to a loopback address, and isLoopbackHost's own F2 contract
    // deliberately excludes it — this must NOT count as loopback.
    it('"0.0.0.0" is not loopback — classifies as http-remote', () => {
      expect(classifyJudgeBaseUrl("http://0.0.0.0")).toBe("http-remote");
    });
  });
});

describe("judgeBaseUrlHost", () => {
  it("returns only the hostname — no userinfo, port, path, or query", () => {
    expect(judgeBaseUrlHost("http://user:s3cr3t@litellm:4000/typesafe?key=abc#frag")).toBe(
      "litellm",
    );
    expect(judgeBaseUrlHost("https://api.typesafe.ai")).toBe("api.typesafe.ai");
  });

  it("still resolves the host for a non-canonical http: form", () => {
    expect(judgeBaseUrlHost("http:evil.example/path")).toBe("evil.example");
  });

  it("returns undefined for an unparseable URL", () => {
    expect(judgeBaseUrlHost("not a url at all")).toBeUndefined();
  });
});

describe("isDisallowedLiteralHost (THE-1125 security review)", () => {
  it.each(["127.0.0.1", "localhost", "::1", "example.com", "internal.corp"])(
    "false for a loopback literal or a hostname (DNS is never resolved): %s",
    (host) => {
      expect(isDisallowedLiteralHost(host)).toBe(false);
    },
  );

  it.each([
    ["0.0.0.0", "unspecified"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["172.20.0.1", "RFC1918 172.16/12"],
    ["192.168.1.10", "RFC1918 192.168/16"],
    ["169.254.169.254", "link-local / cloud metadata"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["::", "IPv6 unspecified"],
    ["fd00::1", "IPv6 unique-local"],
    ["fe80::1", "IPv6 link-local"],
    ["::ffff:169.254.169.254", "IPv4-mapped IPv6 metadata"],
  ])("true for %s (%s)", (host) => {
    expect(isDisallowedLiteralHost(host)).toBe(true);
  });

  it("172.15.x and 172.32.x are OUTSIDE the RFC1918 172.16/12 block — not disallowed by this rule", () => {
    expect(isDisallowedLiteralHost("172.15.0.1")).toBe(false);
    expect(isDisallowedLiteralHost("172.32.0.1")).toBe(false);
  });

  it("127/8 is never flagged by this function — isLoopbackHost owns that range", () => {
    expect(isDisallowedLiteralHost("127.5.5.5")).toBe(false);
  });
});
