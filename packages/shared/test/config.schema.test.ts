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

  // THE-456 (audit #3): a remote (non-loopback) jwt bind must ALSO bind the token audience — a bare
  // HS256 secret with no audience is now refused off loopback (audience-optional HS256 is loopback-only).
  it("allows non-loopback HTTP jwt when an audience is bound (F2 / THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwtSecret: "x".repeat(32), audience: "https://mcp.example.com" },
      transports: { http: { enabled: true, host: "0.0.0.0" } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-loopback HTTP jwt with no audience/resource (THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwtSecret: "x".repeat(32) },
      transports: { http: { enabled: true, host: "0.0.0.0" } },
    });
    expect(r.success).toBe(false);
  });

  it("keeps audience-optional HS256 on a loopback bind (THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwtSecret: "x".repeat(32) },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a JWKS config with no audience/resource, even on loopback (THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwks: { keys: [] } },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(false);
  });

  it("allows a JWKS config when an audience is bound (THE-456)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "jwt", jwks: { keys: [] }, audience: "https://mcp.example.com" },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an issuer with no bound audience — partial binding (THE-456)", () => {
    // Setting issuer (tokens from an external AS) without an audience validates only half the claim.
    const issuerOnly = {
      ...base,
      auth: { mode: "jwt" as const, jwtSecret: "x".repeat(32), issuer: "https://as.example.com" },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    };
    expect(ServerConfigSchema.safeParse(issuerOnly).success).toBe(false);
    // Bind an audience (here via the PRM resource) -> both halves validated -> accepted.
    expect(
      ServerConfigSchema.safeParse({
        ...issuerOnly,
        auth: { ...issuerOnly.auth, resource: "https://mcp.example.com" },
      }).success,
    ).toBe(true);
  });

  it("still serves a PRM resource without a local issuer check (THE-456)", () => {
    // A PRM config advertises authorization servers for discovery; the resource doubles as the bound
    // audience. It does not, by itself, force a local issuer claim, so this stays valid.
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: {
        mode: "jwt",
        jwtSecret: "x".repeat(32),
        resource: "https://mcp.example.com",
        authorizationServers: ["https://as.example.com"],
      },
      transports: { http: { enabled: true, host: "127.0.0.1" } },
    });
    expect(r.success).toBe(true);
  });

  // F2 (review hardening): a malformed 127.x.x.x address has invalid octets and is
  // NOT loopback, so an unauthenticated bind to it must still be refused.
  it("rejects a malformed 127.x host with auth.mode 'none' (F2)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "none" },
      transports: { http: { enabled: true, host: "127.999.999.999" } },
    });
    expect(r.success).toBe(false);
  });

  // F2 (review hardening): bracketed IPv6 loopback normalizes to ::1 and is allowed.
  it("allows unauthenticated HTTP on a bracketed IPv6 loopback host (F2)", () => {
    const r = ServerConfigSchema.safeParse({
      ...base,
      auth: { mode: "none" },
      transports: { http: { enabled: true, host: "[::1]" } },
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
