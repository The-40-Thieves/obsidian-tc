import { describe, expect, it } from "vitest";
import { ObsidianTcError, ServerConfigSchema } from "../src/index";

const base = { vaults: [{ id: "main", path: "/v" }] };

describe("ServerConfigSchema", () => {
  it("accepts a minimal config and applies transport/auth defaults", () => {
    const c = ServerConfigSchema.parse(base);
    expect(c.auth.mode).toBe("none");
    expect(c.transports.http.enabled).toBe(false);
    expect(c.transports.http.host).toBe("127.0.0.1");
  });

  // F8: "oauth" was accepted at config load but returned 501 at request time; it is
  // no longer a valid auth mode (rejected at load).
  it("rejects auth.mode 'oauth' (F8)", () => {
    expect(ServerConfigSchema.safeParse({ ...base, auth: { mode: "oauth" } }).success).toBe(false);
  });

  // F2: never run an unauthenticated server on a routable host.
  it("rejects HTTP on a non-loopback host with auth.mode 'none' (F2)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "none" },
      transports: { http: { enabled: true, host: "0.0.0.0" } },
    });
    expect(r.success).toBe(false);
  });

  it("allows unauthenticated HTTP on a loopback host (F2)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "none" },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(true);
  });

  it("allows non-loopback HTTP when authenticated with jwt (F2)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwtSecret: "x".repeat(32) },
      transports: { http: { enabled: true, host: "0.0.0.0" } },
    });
    expect(r.success).toBe(true);
  });
});

describe("ObsidianTcError", () => {
  it("marks throttled retryable and forbidden non-retryable", () => {
    expect(new ObsidianTcError("throttled", "x").retryable).toBe(true);
    expect(new ObsidianTcError("forbidden", "x").retryable).toBe(false);
  });

  it("serializes to a structured ErrorJSON with details", () => {
    const j = new ObsidianTcError("acl_denied", "denied", { path: "/x" }).toJSON();
    expect(j).toMatchObject({ code: "acl_denied", retryable: false, details: { path: "/x" } });
  });
});
