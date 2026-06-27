import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createJwtVerifier, type TokenVerifier } from "../src/auth/verifier";

const SECRET = "x".repeat(32);

async function mint(
  claims: Record<string, unknown>,
  opts: { secret?: string; exp?: string | number; iat?: number; sub?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(opts.sub ?? "anon")
    .setExpirationTime(opts.exp ?? "1h");
  if (opts.iat !== undefined) jwt.setIssuedAt(opts.iat);
  return jwt.sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

describe("token verifier seam (W-AUTH floor)", () => {
  it("createJwtVerifier verifies a valid HS256 token and extracts caller + scopes", async () => {
    const v = createJwtVerifier(SECRET);
    const token = await mint({ scopes: ["read", "write"] }, { sub: "alice" });
    const id = await v.verify(token);
    expect(id.caller).toBe("alice");
    expect([...id.scopes].sort()).toEqual(["read", "write"]);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const v = createJwtVerifier(SECRET);
    const token = await mint({ scopes: [] }, { sub: "x", secret: "y".repeat(32) });
    await expect(v.verify(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const v = createJwtVerifier(SECRET);
    const token = await mint({}, { sub: "x", exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(v.verify(token)).rejects.toThrow();
  });

  it("enforces maxAgeSeconds when the token carries iat", async () => {
    const v = createJwtVerifier(SECRET, { maxAgeSeconds: 60 });
    const token = await mint({}, { sub: "x", iat: Math.floor(Date.now() / 1000) - 3600 });
    await expect(v.verify(token)).rejects.toThrow();
  });

  it("a custom TokenVerifier can be injected at the seam", async () => {
    const custom: TokenVerifier = {
      verify: async () => ({ caller: "svc", scopes: new Set(["admin"]) }),
    };
    const id = await custom.verify("anything");
    expect(id.caller).toBe("svc");
    expect([...id.scopes]).toEqual(["admin"]);
  });
});
