// `doctor` check for auth.mode oidc: a live discovery probe (the same one boot uses), so an
// unreachable or mismatched IdP is a FAIL here before it is a refused boot.
import { describe, expect, it } from "vitest";
import { authOidcCheck } from "../src/doctor/auth-oidc";

const base = {
  authMode: "oidc" as const,
  issuer: "https://idp.example.com",
  audience: "https://vault.example.com/mcp",
  allowedAlgs: ["RS256", "ES256", "EdDSA"],
  clockToleranceSeconds: 30,
  prmConfigured: true,
  requireJti: true,
};
const run = (v: Parameters<typeof authOidcCheck>[0]) =>
  authOidcCheck(v).run({ serverVersion: "t" });

describe("doctor: auth.oidc", () => {
  it("ok when discovery succeeds; reports issuer, jwks_uri and the key count", async () => {
    const r = await run({
      ...base,
      probe: async () => ({ ok: true, jwksUri: "https://idp.example.com/jwks", keyCount: 2 }),
    });
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r.details)).toContain("\"jwksUri\":\"https://idp.example.com\"");
  });

  it("FAILS (not warns) when discovery fails: the server would refuse to boot", async () => {
    const r = await run({
      ...base,
      probe: async () => ({
        ok: false,
        error: "discovery for https://idp.example.com failed: HTTP 500",
      }),
    });
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/HTTP 500/);
    expect(r.remediation).toBeDefined();
  });

  it("warns about advertised-PRM gaps and a missing requireJti", async () => {
    const r = await run({
      ...base,
      prmConfigured: false,
      requireJti: false,
      probe: async () => ({ ok: true, jwksUri: "https://x/j", keyCount: 1 }),
    });
    expect(r.status).toBe("warning");
    expect(JSON.stringify(r.issues)).toMatch(/resource/);
    expect(JSON.stringify(r.issues)).toMatch(/requireJti/);
  });

  it("is a no-op ok outside oidc mode", async () => {
    expect((await run({ ...base, authMode: "jwt" })).status).toBe("ok");
  });

  it("a throwing probe is a fail, not a crash", async () => {
    const r = await run({
      ...base,
      probe: async () => {
        throw new Error("boom");
      },
    });
    expect(r.status).toBe("fail");
  });
});
