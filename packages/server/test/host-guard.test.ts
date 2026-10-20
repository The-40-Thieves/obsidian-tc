// The DNS-rebinding Host check compares against the SDK's canonical hostname (`new URL(...).hostname`):
// IPv6 keeps its brackets, IDN is punycoded, IPv4 shorthand is expanded. An operator entry has to be
// stored in that same form, or a Host the SDK canonicalizes is refused although its entry was accepted.

import { describe, expect, it } from "vitest";
import { hostnameOf, isHostAllowed } from "../src/transports/host-guard";

describe("isHostAllowed matches the SDK's canonical hostname (THE-271)", () => {
  it("admits a bracketed IPv6 entry by its Host header, with and without the port", () => {
    expect(isHostAllowed("[fd00::1]:8765", ["[fd00::1]:8765"])).toBe(true);
    expect(isHostAllowed("[fd00::1]", ["[fd00::1]:8765"])).toBe(true);
    expect(isHostAllowed("[fd00::2]:8765", ["[fd00::1]:8765"])).toBe(false);
  });

  it("admits an IDN entry by its punycode Host header", () => {
    expect(isHostAllowed("xn--bcher-kva.example", ["bücher.example"])).toBe(true);
  });

  it("admits an IPv4 shorthand entry by its expanded Host header", () => {
    expect(isHostAllowed("192.168.0.1", ["192.168.1"])).toBe(true);
  });

  it("still admits loopback with an empty list and refuses a foreign Host", () => {
    expect(isHostAllowed("localhost:8765", [])).toBe(true);
    expect(isHostAllowed("evil.example", [])).toBe(false);
    expect(isHostAllowed("evil.example", ["nas.local"])).toBe(false);
  });
});

describe("hostnameOf", () => {
  it("returns the canonical SDK hostname, keeping IPv6 brackets", () => {
    expect(hostnameOf("[fd00::1]:8765")).toBe("[fd00::1]");
    expect(hostnameOf("bücher.example")).toBe("xn--bcher-kva.example");
    expect(hostnameOf("192.168.1")).toBe("192.168.0.1");
    expect(hostnameOf("nas.local:8765")).toBe("nas.local");
  });
});
