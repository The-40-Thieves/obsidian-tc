// THE-1125 (security-review follow-up) — redact-endpoint.ts is the ONE place `telemetry.endpoint`
// is turned into something safe to print/log/persist. This is the shared helper every surface
// (preview/status, doctor, server_health, boot notice, sender.ts) routes through, so its own
// correctness is the single point of failure for "never leaks a collector secret."
import { describe, expect, it } from "vitest";
import {
  capMessageLength,
  redactEndpoint,
  redactEndpointWithPath,
  scrubEndpointFromMessage,
} from "../src/telemetry/redact-endpoint";

const SECRET_URL = "https://user:pw@collector.example/ingest?key=abc#f";

describe("redactEndpoint", () => {
  it("the exact security-scan test case: userinfo/query/fragment/path all dropped (scheme+host only)", () => {
    expect(redactEndpoint(SECRET_URL)).toBe("https://collector.example");
  });

  it("keeps scheme and host for a plain URL", () => {
    expect(redactEndpoint("https://collector.example:8443/x")).toBe(
      "https://collector.example:8443",
    );
  });

  it("returns a safe placeholder for an unparseable URL, never the raw string", () => {
    expect(redactEndpoint("not a url")).toBe("(unparseable)");
  });
});

describe("redactEndpointWithPath (opt-in, `telemetry preview --show-path` only)", () => {
  it("keeps the path but still drops userinfo/query/fragment", () => {
    expect(redactEndpointWithPath(SECRET_URL)).toBe("https://collector.example/ingest");
  });
});

describe("scrubEndpointFromMessage", () => {
  it("the exact security-scan test case: a transport error embedding the full URL is scrubbed to scheme+host only", () => {
    const message = `fetch failed: request to ${SECRET_URL} failed, reason: connect ECONNREFUSED`;
    const scrubbed = scrubEndpointFromMessage(message, SECRET_URL);
    expect(scrubbed).not.toContain("user:pw");
    expect(scrubbed).not.toContain("key=abc");
    expect(scrubbed).toContain("https://collector.example");
    expect(scrubbed).not.toContain(SECRET_URL);
  });

  it("also scrubs a bare userinfo@host fragment a runtime might normalize the message to", () => {
    const message = "getaddrinfo ENOTFOUND user:pw@collector.example";
    const scrubbed = scrubEndpointFromMessage(message, SECRET_URL);
    expect(scrubbed).not.toContain("user:pw");
  });

  it("leaves an unrelated message untouched", () => {
    expect(scrubEndpointFromMessage("timeout", SECRET_URL)).toBe("timeout");
  });
});

describe("capMessageLength", () => {
  it("passes a short message through unchanged", () => {
    expect(capMessageLength("HTTP 503")).toBe("HTTP 503");
  });

  it("truncates a long message to ~200 chars, appending a marker", () => {
    const long = "x".repeat(1000);
    const capped = capMessageLength(long);
    expect(capped.length).toBeLessThan(1000);
    expect(capped).toContain("[truncated]");
    expect(capped.startsWith("x".repeat(200))).toBe(true);
  });

  it("respects an explicit maxLen", () => {
    expect(capMessageLength("abcdefgh", 4)).toBe("abcd…[truncated]");
  });
});
