import { describe, expect, it } from "vitest";
import {
  classifyJudgeBaseUrl,
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
