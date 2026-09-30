// `auth.mode: "oidc"` config surface: what the schema accepts and, more to the point, refuses.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import {
  buildProtectedResourceMetadata,
  effectiveAudience,
  isPrmConfigured,
} from "../src/auth/protected-resource";

const OIDC = { issuer: "https://idp.example.com", audience: "https://vault.example.com/mcp" };
const parse = (auth: unknown, extra: Record<string, unknown> = {}) =>
  ServerConfigSchema.safeParse({ vaults: [{ id: "v1", path: "/tmp/v1" }], auth, ...extra });
const ok = (auth: unknown, extra?: Record<string, unknown>) => {
  const r = parse(auth, extra);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
};
const refused = (auth: unknown, re: RegExp, extra?: Record<string, unknown>) => {
  const r = parse(auth, extra);
  expect(r.success).toBe(false);
  expect(JSON.stringify(r.error?.issues)).toMatch(re);
};

describe("auth.oidc schema", () => {
  it("accepts a minimal block and applies the safe defaults", () => {
    const o = ok({ mode: "oidc", oidc: OIDC }).auth.oidc;
    expect(o?.allowedAlgs).toEqual(["RS256", "ES256", "EdDSA"]);
    expect(o?.clockToleranceSeconds).toBe(30);
    expect(o?.claimMapping).toEqual({ subject: "sub", scopes: "scope" });
    expect(o?.requireAtJwtType).toBe(false);
  });

  it("requires the oidc block when mode is oidc", () => {
    refused({ mode: "oidc" }, /oidc/);
  });

  it("refuses an oidc block under another mode: it would look protected and not be", () => {
    refused({ mode: "none", oidc: OIDC }, /oidc/);
    refused({ mode: "jwt", jwtSecret: "x".repeat(32), oidc: OIDC }, /oidc/);
  });

  it("requires an audience, non-empty", () => {
    refused({ mode: "oidc", oidc: { issuer: OIDC.issuer } }, /audience/);
    refused({ mode: "oidc", oidc: { ...OIDC, audience: "" } }, /audience|too_small/);
    refused({ mode: "oidc", oidc: { ...OIDC, audience: [] } }, /audience|too_small/);
    expect(
      ok({ mode: "oidc", oidc: { ...OIDC, audience: ["a", "b"] } }).auth.oidc?.audience,
    ).toEqual(["a", "b"]);
  });

  it.each([
    ["http scheme", "http://idp.example.com"],
    ["loopback http", "http://127.0.0.1:9000"],
    ["query", "https://idp.example.com/?a=1"],
    ["fragment", "https://idp.example.com/#x"],
    ["userinfo", "https://u:p@idp.example.com"],
    ["not a url", "idp.example.com"],
  ])("refuses an issuer with %s", (_n, issuer) => {
    refused({ mode: "oidc", oidc: { ...OIDC, issuer } }, /issuer/);
  });

  it("refuses an http jwksUri override", () => {
    refused({ mode: "oidc", oidc: { ...OIDC, jwksUri: "http://idp.example.com/jwks" } }, /jwksUri/);
    expect(
      ok({ mode: "oidc", oidc: { ...OIDC, jwksUri: "https://idp.example.com/jwks" } }).auth.oidc
        ?.jwksUri,
    ).toBe("https://idp.example.com/jwks");
  });

  it.each(["HS256", "HS384", "HS512", "none", "RS1", ""])("never allows alg %j", (alg) => {
    refused({ mode: "oidc", oidc: { ...OIDC, allowedAlgs: [alg] } }, /allowedAlgs/);
  });

  it("refuses an empty allowedAlgs and accepts any asymmetric subset", () => {
    refused({ mode: "oidc", oidc: { ...OIDC, allowedAlgs: [] } }, /allowedAlgs/);
    expect(
      ok({ mode: "oidc", oidc: { ...OIDC, allowedAlgs: ["PS256", "ES384"] } }).auth.oidc
        ?.allowedAlgs,
    ).toEqual(["PS256", "ES384"]);
  });

  it("bounds clockToleranceSeconds and the discovery cache TTL", () => {
    refused(
      { mode: "oidc", oidc: { ...OIDC, clockToleranceSeconds: 301 } },
      /clockToleranceSeconds/,
    );
    refused(
      { mode: "oidc", oidc: { ...OIDC, clockToleranceSeconds: -1 } },
      /clockToleranceSeconds/,
    );
    expect(
      ok({ mode: "oidc", oidc: { ...OIDC, clockToleranceSeconds: 0 } }).auth.oidc
        ?.clockToleranceSeconds,
    ).toBe(0);
    refused({ mode: "oidc", oidc: { ...OIDC, discoveryCacheSeconds: 5 } }, /discoveryCacheSeconds/);
    refused(
      { mode: "oidc", oidc: { ...OIDC, discoveryCacheSeconds: 86401 } },
      /discoveryCacheSeconds/,
    );
  });

  it("rejects unknown keys in the block (a typo must not silently drop a restriction)", () => {
    refused({ mode: "oidc", oidc: { ...OIDC, allowedAlg: ["RS256"] } }, /allowedAlg/);
  });

  it("accepts a claim mapping and requiredClaims", () => {
    const o = ok({
      mode: "oidc",
      oidc: {
        ...OIDC,
        clientId: "abc",
        requiredClaims: ["email"],
        claimMapping: { scopes: "scp", principal: "email" },
      },
    }).auth.oidc;
    expect(o?.claimMapping).toEqual({ subject: "sub", scopes: "scp", principal: "email" });
    expect(o?.clientId).toBe("abc");
  });

  it("refuses the jwt-mode key/issuer keys beside oidc: one trust anchor, not two", () => {
    for (const k of [
      { jwks: { keys: [] } },
      { jwksFile: "/tmp/x.json" },
      { jwksUri: "https://x.example.com/jwks" },
      { algorithms: ["RS256"] },
      { issuer: "https://other.example.com" },
      { audience: "x" },
    ]) {
      refused({ mode: "oidc", oidc: OIDC, ...k }, /auth\.oidc|oidc/);
    }
  });

  it("allows a jwtSecret beside oidc (it still keys the HITL codec) but it never verifies a bearer", () => {
    expect(ok({ mode: "oidc", oidc: OIDC, jwtSecret: "x".repeat(32) }).auth.mode).toBe("oidc");
  });

  it("refuses an authorizationServers list that disagrees with the issuer", () => {
    refused(
      { mode: "oidc", oidc: OIDC, authorizationServers: ["https://evil.example.com"] },
      /authorizationServers/,
    );
    ok({ mode: "oidc", oidc: OIDC, authorizationServers: [OIDC.issuer] });
  });

  it("the http transport on a routable host is fine (oidc is authenticated)", () => {
    ok({ mode: "oidc", oidc: OIDC }, { transports: { http: { enabled: true, host: "0.0.0.0" } } });
  });
});

describe("oidc mode and Protected Resource Metadata (RFC 9728)", () => {
  const RES = "https://vault.example.com/mcp";
  it("advertises the EXTERNAL issuer as the authorization server, with the configured resource", () => {
    const { auth } = ok({
      mode: "oidc",
      oidc: OIDC,
      resource: RES,
      scopesSupported: ["read:notes"],
      resourceName: "Vault",
    });
    expect(isPrmConfigured(auth)).toBe(true);
    expect(buildProtectedResourceMetadata(auth)).toEqual({
      resource: RES,
      authorization_servers: [OIDC.issuer],
      scopes_supported: ["read:notes"],
      resource_name: "Vault",
      bearer_methods_supported: ["header"],
    });
  });

  it("is not configured without a resource (RFC 9728: resource is REQUIRED)", () => {
    expect(isPrmConfigured(ok({ mode: "oidc", oidc: OIDC }).auth)).toBe(false);
  });

  it("the bound audience is auth.oidc.audience, not the resource", () => {
    const { auth } = ok({
      mode: "oidc",
      oidc: { ...OIDC, audience: "api://vault" },
      resource: RES,
    });
    expect(effectiveAudience(auth)).toBe("api://vault");
  });
});

describe("auth.oidc review fixes: schema", () => {
  const oidc = (o: Record<string, unknown>) => ({ mode: "oidc", oidc: { ...OIDC, ...o } });

  it("defaults: allowPrivateNetwork is false and allowedJwksHosts is unset", () => {
    const o = ok(oidc({})).auth.oidc;
    expect(o?.allowPrivateNetwork).toBe(false);
    expect(o?.allowedJwksHosts).toBeUndefined();
  });

  it.each([
    "https://cdn.example.com",
    "cdn.example.com/path",
    "user@cdn.example.com",
    "cdn.example.com:8443",
    "",
    "*.example.com",
  ])("allowedJwksHosts refuses %j (bare hostnames only)", (h) => {
    refused(oidc({ allowedJwksHosts: [h] }), /allowedJwksHosts/);
  });

  it("allowedJwksHosts accepts bare hostnames", () => {
    expect(
      ok(oidc({ allowedJwksHosts: ["www.googleapis.com"] })).auth.oidc?.allowedJwksHosts,
    ).toEqual(["www.googleapis.com"]);
  });

  it("a persona or vault mapping without its allowlist is refused", () => {
    refused(oidc({ claimMapping: { persona: "p" } }), /allowedPersonas/);
    refused(oidc({ claimMapping: { persona: "p", allowedPersonas: [] } }), /allowedPersonas/);
    refused(oidc({ claimMapping: { vault: "v" } }), /allowedVaults/);
    refused(oidc({ claimMapping: { vault: "v", allowedVaults: [] } }), /allowedVaults/);
    const m = ok(
      oidc({
        claimMapping: { persona: "p", allowedPersonas: ["a"], vault: "v", allowedVaults: ["v1"] },
      }),
    ).auth.oidc?.claimMapping;
    expect(m?.allowedPersonas).toEqual(["a"]);
    expect(m?.allowedVaults).toEqual(["v1"]);
  });

  it("scopeMap values must be fully-qualified scopes", () => {
    expect(
      ok(oidc({ claimMapping: { scopeMap: { admin: ["admin:auth"], r: ["read:*"] } } })).auth.oidc
        ?.claimMapping.scopeMap,
    ).toEqual({ admin: ["admin:auth"], r: ["read:*"] });
    for (const bad of ["admin", "*", "*:*", "foo:bar", "read:", ":notes"]) {
      refused(oidc({ claimMapping: { scopeMap: { role: [bad] } } }), /scopeMap/);
    }
    refused(oidc({ claimMapping: { scopeMap: { role: [] } } }), /scopeMap/);
  });

  it("claim names accept a dotted string or an array of literal segments", () => {
    const m = ok(
      oidc({
        claimMapping: { scopes: ["https://x.example/roles"], subject: ["a.b", "c"] },
        requiredClaims: ["email_verified", ["https://x.example/uid"]],
      }),
    ).auth.oidc;
    expect(m?.claimMapping.scopes).toEqual(["https://x.example/roles"]);
    refused(oidc({ claimMapping: { scopes: [] } }), /scopes/);
    refused(oidc({ claimMapping: { scopes: [""] } }), /scopes/);
  });

  it("requiredClaims accepts an object of expected primitive values, nothing else", () => {
    expect(
      ok(oidc({ requiredClaims: { email_verified: true, hd: "x.com", n: 1 } })).auth.oidc
        ?.requiredClaims,
    ).toEqual({ email_verified: true, hd: "x.com", n: 1 });
    refused(oidc({ requiredClaims: { a: null } }), /requiredClaims/);
    refused(oidc({ requiredClaims: { a: { b: 1 } } }), /requiredClaims/);
    refused(oidc({ requiredClaims: {} }), /requiredClaims/);
  });
});
