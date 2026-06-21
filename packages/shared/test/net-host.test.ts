import { describe, expect, it } from "vitest";
import { isLoopbackHost, normalizeHostForBind } from "../src/net-host";

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
