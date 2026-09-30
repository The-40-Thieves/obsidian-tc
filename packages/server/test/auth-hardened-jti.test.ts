// The hardened security profile turns `auth.requireJti` on: a jti-less bearer cannot be revoked
// individually, so the restrained posture refuses one on every verify path. The schema default stays
// false (flipped at the next major), so an operator who has not opted in sees no change.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthRejection } from "../src/auth/jwt";
import { createOidcVerifier } from "../src/auth/oidc";
import { createTokenVerifier } from "../src/auth/verifier";
import { finalizeConfig } from "../src/config/load";
import { applySecurityProfile } from "../src/config/security-profile";
import { AUDIENCE, ISSUER, type MockIdp, publicResolver, startMockIdp } from "./oidc-mock-provider";

const SECRET = "hardened-jti-test-secret-0123456789abcdef";
const VAULTS = [{ id: "main", path: "/v" }];

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthRejection) return e.reason;
    throw e;
  }
  return "accepted";
}

const now = () => Math.floor(Date.now() / 1000);
const hs256 = (extra: Record<string, unknown> = {}) =>
  new SignJWT({ sub: "agent", scopes: ["read:notes"], ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now())
    .setExpirationTime(now() + 600)
    .sign(new TextEncoder().encode(SECRET));

describe("hardened profile sets auth.requireJti", () => {
  it("applySecurityProfile fills auth.requireJti true, and leaves the rest of auth to the operator", () => {
    const raw = applySecurityProfile({
      vaults: VAULTS,
      securityProfile: "hardened",
      auth: { mode: "jwt", jwtSecret: SECRET },
    });
    expect(raw.auth).toEqual({ mode: "jwt", jwtSecret: SECRET, requireJti: true });
  });

  it("an explicit auth.requireJti: false still wins over the profile", () => {
    const cfg = finalizeConfig({
      vaults: VAULTS,
      securityProfile: "hardened",
      auth: { mode: "jwt", jwtSecret: SECRET, requireJti: false },
      cacheDir: ".otc-test-cache",
    });
    expect(cfg.auth.requireJti).toBe(false);
  });

  it("the default and trusted-local configs are unchanged: requireJti stays false", () => {
    expect(ServerConfigSchema.parse({ vaults: VAULTS }).auth.requireJti).toBe(false);
    expect(
      finalizeConfig({
        vaults: VAULTS,
        securityProfile: "trusted-local",
        cacheDir: ".otc-test-cache",
      }).auth.requireJti,
    ).toBe(false);
  });

  it("a hardened config rejects a jti-less HS256 token with jti_required, and accepts one with a jti", async () => {
    const cfg = finalizeConfig({
      vaults: VAULTS,
      securityProfile: "hardened",
      auth: { mode: "jwt", jwtSecret: SECRET },
      cacheDir: ".otc-test-cache",
    });
    expect(cfg.auth.requireJti).toBe(true);
    const verifier = createTokenVerifier({
      secret: cfg.auth.jwtSecret,
      requireJti: cfg.auth.requireJti,
    });
    expect(await reasonOf(verifier.verify(await hs256()))).toBe("jti_required");
    expect(await reasonOf(verifier.verify(await hs256({ jti: "abc" })))).toBe("accepted");
  });

  it("a hardened config rejects a jti-less JWKS token with jti_required", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA", use: "sig" };
    const cfg = finalizeConfig({
      vaults: VAULTS,
      securityProfile: "hardened",
      auth: { mode: "jwt", jwks: { keys: [jwk] }, audience: "aud-1" },
      cacheDir: ".otc-test-cache",
    });
    const verifier = createTokenVerifier({
      jwks: cfg.auth.jwks,
      audience: cfg.auth.audience,
      requireJti: cfg.auth.requireJti,
    });
    const sign = (extra: Record<string, unknown>) =>
      new SignJWT({ sub: "agent", aud: "aud-1", ...extra })
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuedAt(now())
        .setExpirationTime(now() + 600)
        .sign(privateKey);
    expect(await reasonOf(verifier.verify(await sign({})))).toBe("jti_required");
    expect(await reasonOf(verifier.verify(await sign({ jti: "abc" })))).toBe("accepted");
  });
});

describe("hardened profile: OIDC", () => {
  let idp: MockIdp;
  beforeEach(async () => {
    idp = await startMockIdp();
  });
  afterEach(() => idp.close());

  it("a hardened oidc config rejects a jti-less IdP token with jti_required", async () => {
    const cfg = finalizeConfig({
      vaults: VAULTS,
      securityProfile: "hardened",
      auth: { mode: "oidc", oidc: { issuer: ISSUER, audience: AUDIENCE } },
      cacheDir: ".otc-test-cache",
    });
    expect(cfg.auth.requireJti).toBe(true);
    const v = await createOidcVerifier(cfg.auth, {
      fetch: idp.fetch,
      jwksCooldownMs: 0,
      resolveHost: publicResolver,
    });
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["jti"] })))).toBe("jti_required");
    expect(await reasonOf(v.verify(await idp.sign({})))).toBe("accepted");
  });
});
