import { describe, expect, it } from "vitest";
import {
  isListedOnlyPrivateAddress,
  isPlainHttpHostListed,
  isPrivateNetworkAddress,
  normalizePlainHttpHost,
  typesafeJudgeIssues,
} from "../src/net-host";

describe("normalizePlainHttpHost", () => {
  it("lowercases, strips one trailing dot, and punycodes IDNA names", () => {
    expect(normalizePlainHttpHost("LiteLLM")).toBe("litellm");
    expect(normalizePlainHttpHost("litellm.")).toBe("litellm");
    expect(normalizePlainHttpHost("Bücher.Example")).toBe("xn--bcher-kva.example");
    expect(normalizePlainHttpHost("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  it("canonicalizes IP literals the way a URL parser does", () => {
    expect(normalizePlainHttpHost("0x08080808")).toBe("8.8.8.8");
    expect(normalizePlainHttpHost("134744072")).toBe("8.8.8.8");
    expect(normalizePlainHttpHost("[FD00:0:0:0:0:0:0:1]")).toBe("[fd00::1]");
    expect(normalizePlainHttpHost("fd00::1")).toBe("[fd00::1]");
  });

  it("refuses wildcards, ports, paths, userinfo, whitespace and empty values", () => {
    for (const bad of [
      "*",
      "*.example.com",
      "litellm:4000",
      "litellm/x",
      "user@litellm",
      "lit ellm",
      "",
      "  ",
      "http://litellm",
      "lite?llm",
      "lite#llm",
    ]) {
      expect(normalizePlainHttpHost(bad), bad).toBeUndefined();
    }
  });
});

describe("isPlainHttpHostListed", () => {
  it("matches exact normalized hostnames only, with no suffix or wildcard matching", () => {
    expect(isPlainHttpHostListed("litellm", ["LiteLLM"])).toBe(true);
    expect(isPlainHttpHostListed("litellm", ["litellm."])).toBe(true);
    expect(isPlainHttpHostListed("xn--bcher-kva.example", ["bücher.example"])).toBe(true);
    expect(isPlainHttpHostListed("evil.litellm", ["litellm"])).toBe(false);
    expect(isPlainHttpHostListed("litellm.evil.com", ["litellm"])).toBe(false);
    expect(isPlainHttpHostListed("example.com", [])).toBe(false);
    expect(isPlainHttpHostListed("example.com", ["*"])).toBe(false);
    expect(isPlainHttpHostListed("example.com", ["*.com"])).toBe(false);
  });
});

describe("isPrivateNetworkAddress", () => {
  it("accepts loopback, RFC1918 and ULA, including IPv4-mapped forms", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.8.8",
      "::1",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.18.0.5",
      "172.31.255.255",
      "192.168.1.1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:ac12:5",
    ]) {
      expect(isPrivateNetworkAddress(ip), ip).toBe(true);
    }
  });

  it("refuses public, reserved-but-not-listed and malformed addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "172.15.255.255",
      "172.32.0.1",
      "192.169.0.1",
      "169.253.0.1",
      "169.254.169.254",
      "169.254.0.1",
      "fe80::1",
      "febf::1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "100.64.0.1",
      "0.0.0.0",
      "::",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "2001:4860:4860::8888",
      "fec0::1",
      "fc::1",
      "fe8::1",
      "::8.8.8.8",
      "64:ff9b::a00:1",
      "not-an-ip",
      "",
      "10.0.0",
      "10.0.0.256",
    ]) {
      expect(isPrivateNetworkAddress(ip), ip).toBe(false);
    }
  });
});

describe("isListedOnlyPrivateAddress", () => {
  it("accepts exactly the Tailscale/CGNAT range 100.64.0.0/10, including IPv4-mapped forms", () => {
    for (const ip of [
      "100.64.0.0",
      "100.64.0.1",
      "100.101.102.103",
      "100.127.255.255",
      "::ffff:100.101.102.103",
      "::ffff:6465:6667",
    ]) {
      expect(isListedOnlyPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("refuses everything outside it, and never widens isPrivateNetworkAddress", () => {
    for (const ip of [
      "100.63.255.255",
      "100.128.0.0",
      "8.8.8.8",
      "169.254.169.254",
      "10.0.0.1",
      "127.0.0.1",
      "fd7a:115c:a1e0::1",
      "::ffff:8.8.8.8",
      "not-an-ip",
      "",
    ]) {
      expect(isListedOnlyPrivateAddress(ip), ip).toBe(false);
    }
    expect(isPrivateNetworkAddress("100.101.102.103")).toBe(false);
  });
});

describe("typesafeJudgeIssues plainHttpHosts", () => {
  const base = { provider: "gateway", baseUrl: "http://litellm:4000/typesafe" };

  it("refuses a remote http baseUrl whose host is neither listed nor opted in by the legacy flag", () => {
    const issues = typesafeJudgeIssues(base, "judge", "Noul");
    expect(issues.map((i) => i.path)).toContain("baseUrl");
  });

  it("accepts a listed host, case-insensitively", () => {
    expect(typesafeJudgeIssues({ ...base, plainHttpHosts: ["LiteLLM"] }, "judge", "Noul")).toEqual(
      [],
    );
  });

  it("refuses a host that is not in a non-empty list, even with the legacy flag unset", () => {
    const issues = typesafeJudgeIssues({ ...base, plainHttpHosts: ["other"] }, "judge", "Noul");
    expect(issues.map((i) => i.path)).toContain("baseUrl");
  });

  it("the deprecated allowPlainHttp still maps to this baseUrl's own host", () => {
    expect(typesafeJudgeIssues({ ...base, allowPlainHttp: true }, "judge", "Noul")).toEqual([]);
  });

  it("flags a malformed plainHttpHosts entry on its own path", () => {
    const issues = typesafeJudgeIssues(
      { ...base, plainHttpHosts: ["*.example.com"] },
      "judge",
      "Noul",
    );
    expect(issues.map((i) => i.path)).toContain("plainHttpHosts");
  });

  it("https and loopback need no entry", () => {
    expect(
      typesafeJudgeIssues({ ...base, baseUrl: "https://api.typesafe.ai" }, "judge", "Noul"),
    ).toEqual([]);
    expect(
      typesafeJudgeIssues({ ...base, baseUrl: "http://127.0.0.1:9000" }, "judge", "Noul"),
    ).toEqual([]);
  });
});
