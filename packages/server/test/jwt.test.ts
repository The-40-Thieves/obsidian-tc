import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyJwt } from "../src/auth/jwt";

const secret = "x".repeat(32);
const key = new TextEncoder().encode(secret);

function mint(
  claims: Record<string, unknown>,
  set: (s: SignJWT) => SignJWT = (s) => s,
): Promise<string> {
  return set(new SignJWT(claims).setProtectedHeader({ alg: "HS256" })).sign(key);
}

describe("verifyJwt (H2)", () => {
  it("accepts a normal HS256 token with exp and extracts sub + scopes", async () => {
    const token = await mint({ sub: "alice", scopes: ["read:notes"] }, (s) =>
      s.setExpirationTime("5m"),
    );
    const id = await verifyJwt(token, secret);
    expect(id.caller).toBe("alice");
    expect(id.scopes.has("read:notes")).toBe(true);
  });

  it("rejects a token with no exp claim (would otherwise never expire)", async () => {
    const token = await mint({ sub: "alice" }); // no setExpirationTime -> no exp
    await expect(verifyJwt(token, secret)).rejects.toThrow();
  });

  it("rejects an already-expired token", async () => {
    const token = await mint({ sub: "alice" }, (s) => s.setExpirationTime("-1s"));
    await expect(verifyJwt(token, secret)).rejects.toThrow();
  });

  it("enforces maxAgeSeconds against iat, but only when iat is present", async () => {
    const oldIat = Math.floor(Date.now() / 1000) - 3600; // issued 1h ago
    const token = await mint({ sub: "alice" }, (s) =>
      s.setIssuedAt(oldIat).setExpirationTime("10h"),
    );
    await expect(verifyJwt(token, secret, { maxAgeSeconds: 60 })).rejects.toThrow();
    // the same token is accepted without a max-age cap
    const id = await verifyJwt(token, secret);
    expect(id.caller).toBe("alice");
  });

  it("accepts an exp-only token (no iat) even when maxAgeSeconds is set", async () => {
    // The max-age cap keys off iat; an exp-only token can't be aged out, so it must
    // still verify. Locks in the "existing exp-only tokens keep working" contract
    // and guards against a regression that fires the guard on a missing iat.
    const token = await mint({ sub: "alice" }, (s) => s.setExpirationTime("10h"));
    const id = await verifyJwt(token, secret, { maxAgeSeconds: 60 });
    expect(id.caller).toBe("alice");
  });

  it("rejects an empty secret instead of verifying a token against it", async () => {
    // An empty configured secret must never authenticate anyone — fail closed rather
    // than letting jose verify against a zero-length key.
    const token = await mint({ sub: "alice" }, (s) => s.setExpirationTime("5m"));
    await expect(verifyJwt(token, "")).rejects.toThrow(/empty secret/i);
  });
});

describe("verifyJwt audience/issuer binding (THE-456)", () => {
  const AUD = "https://mcp.example.com/mcp";
  const ISS = "https://auth.example.com";

  it("accepts a token whose aud/iss match the configured values", async () => {
    const token = await mint({ sub: "alice" }, (s) =>
      s.setAudience(AUD).setIssuer(ISS).setExpirationTime("5m"),
    );
    const id = await verifyJwt(token, secret, { audience: AUD, issuer: ISS });
    expect(id.caller).toBe("alice");
  });

  it("rejects a token minted for a different audience (confused-deputy / passthrough)", async () => {
    const token = await mint({ sub: "alice" }, (s) =>
      s.setAudience("https://other-service.example.com").setExpirationTime("5m"),
    );
    await expect(verifyJwt(token, secret, { audience: AUD })).rejects.toThrow();
  });

  it("rejects a token with no aud claim when an audience is required", async () => {
    const token = await mint({ sub: "alice" }, (s) => s.setExpirationTime("5m"));
    await expect(verifyJwt(token, secret, { audience: AUD })).rejects.toThrow();
  });

  it("rejects a token from the wrong issuer", async () => {
    const token = await mint({ sub: "alice" }, (s) =>
      s.setIssuer("https://evil.example.com").setExpirationTime("5m"),
    );
    await expect(verifyJwt(token, secret, { issuer: ISS })).rejects.toThrow();
  });

  it("does not check aud/iss when unset — local self-issued tokens keep working", async () => {
    const token = await mint({ sub: "alice" }, (s) => s.setExpirationTime("5m"));
    const id = await verifyJwt(token, secret); // no audience/issuer configured
    expect(id.caller).toBe("alice");
  });
});
