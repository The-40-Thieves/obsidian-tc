import { describe, expect, it } from "vitest";
import {
  formatIpAddress,
  ipInCidr,
  parseForwardedHop,
  parseIpAddress,
  parseIpCidr,
} from "../src/net-ip";

const fmt = (s: string): string | undefined => {
  const a = parseIpAddress(s);
  return a === undefined ? undefined : formatIpAddress(a);
};

describe("parseIpAddress", () => {
  it("reads IPv4 and renders it dotted", () => {
    expect(fmt("203.0.113.5")).toBe("203.0.113.5");
    expect(fmt("0.0.0.0")).toBe("0.0.0.0");
  });

  it("normalises IPv4-mapped IPv6 to the IPv4 address, in every spelling", () => {
    expect(fmt("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(fmt("::FFFF:203.0.113.5")).toBe("203.0.113.5");
    expect(fmt("::ffff:cb00:7105")).toBe("203.0.113.5");
    expect(fmt("0:0:0:0:0:ffff:cb00:7105")).toBe("203.0.113.5");
    expect(parseIpAddress("::ffff:127.0.0.1")).toBe(parseIpAddress("127.0.0.1"));
  });

  it("reads IPv6, compressed or not, to one canonical text", () => {
    const a = fmt("2001:db8::1");
    expect(a).toBe(fmt("2001:0db8:0000:0000:0000:0000:0000:0001"));
    expect(a).toBe(fmt("2001:DB8:0:0:0:0:0:1"));
    expect(fmt("::1")).toBe(fmt("0:0:0:0:0:0:0:1"));
    expect(fmt("::")).toBeDefined();
    expect(fmt("1:2:3:4:5:6:7::")).toBeDefined();
  });

  it("refuses everything that is not a bare address", () => {
    for (const bad of [
      "",
      " ",
      "unknown",
      "_hidden",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "01.2.3.4",
      "1.2.3.04",
      "1.2.3.4 ",
      " 1.2.3.4",
      "1.2.3.4:80",
      "[::1]",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "1::2::3",
      ":::",
      ":1:2:3:4:5:6:7",
      "12345::1",
      "g::1",
      "::ffff:1.2.3.256",
      "::1%eth0",
      "1.2.3.4/24",
      "0x7f.0.0.1",
      "2130706433",
    ]) {
      expect(parseIpAddress(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("parseForwardedHop", () => {
  it("accepts the shapes a proxy writes: padding, quotes, brackets, ports", () => {
    expect(parseForwardedHop("  203.0.113.5  ")).toBe(parseIpAddress("203.0.113.5"));
    expect(parseForwardedHop("203.0.113.5:51234")).toBe(parseIpAddress("203.0.113.5"));
    expect(parseForwardedHop("[2001:db8::7]")).toBe(parseIpAddress("2001:db8::7"));
    expect(parseForwardedHop("[2001:db8::7]:443")).toBe(parseIpAddress("2001:db8::7"));
    expect(parseForwardedHop("2001:db8::7")).toBe(parseIpAddress("2001:db8::7"));
    expect(parseForwardedHop('"[2001:db8::7]:443"')).toBe(parseIpAddress("2001:db8::7"));
    expect(parseForwardedHop("::ffff:203.0.113.5")).toBe(parseIpAddress("203.0.113.5"));
  });

  it("refuses garbage, a bad port, an unterminated bracket and obfuscated identifiers", () => {
    for (const bad of [
      "",
      "unknown",
      "_hidden",
      "for=203.0.113.5",
      "203.0.113.5:",
      "203.0.113.5:99999",
      "203.0.113.5:80:80",
      "203.0.113.5:ab",
      "[2001:db8::7",
      "[2001:db8::7]x",
      "[2001:db8::7]:",
      "[203.0.113.5.5]",
      "203.0.113.5 198.51.100.1",
      "203.0.113.5;",
      "<script>",
      "2001:db8::7:80:80:80:80:80:80:80",
    ]) {
      expect(parseForwardedHop(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("parseIpCidr / ipInCidr", () => {
  const inside = (cidr: string, ip: string): boolean => {
    const c = parseIpCidr(cidr);
    const a = parseIpAddress(ip);
    if (c === undefined || a === undefined) throw new Error(`unparsable ${cidr} / ${ip}`);
    return ipInCidr(a, c);
  };

  it("a bare address is a host entry, in either family", () => {
    expect(inside("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(inside("127.0.0.1", "127.0.0.2")).toBe(false);
    expect(inside("::1", "::1")).toBe(true);
    expect(inside("::1", "::2")).toBe(false);
  });

  it("an IPv4 entry matches the same address spelled IPv4-mapped, and the reverse", () => {
    expect(inside("127.0.0.1", "::ffff:127.0.0.1")).toBe(true);
    expect(inside("::ffff:127.0.0.1", "127.0.0.1")).toBe(true);
    expect(inside("::ffff:10.0.0.0/104", "10.1.2.3")).toBe(true);
  });

  it("IPv4 prefixes", () => {
    expect(inside("10.0.0.0/8", "10.255.255.255")).toBe(true);
    expect(inside("10.0.0.0/8", "11.0.0.0")).toBe(false);
    expect(inside("172.16.0.0/12", "172.31.255.255")).toBe(true);
    expect(inside("172.16.0.0/12", "172.32.0.0")).toBe(false);
    expect(inside("192.168.1.7/32", "192.168.1.7")).toBe(true);
    expect(inside("192.168.1.7/32", "192.168.1.8")).toBe(false);
    expect(inside("172.18.0.5/16", "172.18.200.9")).toBe(true);
  });

  it("IPv6 prefixes", () => {
    expect(inside("fc00::/7", "fd12:3456::1")).toBe(true);
    expect(inside("fc00::/7", "fe80::1")).toBe(false);
    expect(inside("2001:db8::/32", "2001:db8:ffff::1")).toBe(true);
    expect(inside("2001:db8::/32", "2001:db9::1")).toBe(false);
    expect(inside("::1/128", "::1")).toBe(true);
  });

  it("an IPv4 prefix never matches an unrelated IPv6 address", () => {
    expect(inside("0.0.0.0/1", "::1")).toBe(false);
    expect(inside("10.0.0.0/8", "2001:db8::a00:1")).toBe(false);
  });

  it("refuses a malformed entry, a bad prefix and a prefix of 0 (trust everything)", () => {
    for (const bad of [
      "",
      "10.0.0.0/",
      "/8",
      "10.0.0.0/33",
      "10.0.0.0/-1",
      "10.0.0.0/08x",
      "10.0.0.0/8/8",
      "::1/129",
      "10.0.0.0/0",
      "0.0.0.0/0",
      "::/0",
      "example.com",
      "localhost",
      "10.0.0",
      "*",
      " 10.0.0.1",
    ]) {
      expect(parseIpCidr(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
