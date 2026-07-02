// THE-297 — asymmetric JWT: RS256 + EdDSA accept, kid rotation, alg-confusion rejects.
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createTokenVerifier } from "../src/auth/verifier";

async function makeKeys() {
  const rsa = await generateKeyPair("RS256");
  const ed = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const rsaJwk = { ...(await exportJWK(rsa.publicKey)), kid: "rsa-1", alg: "RS256" };
  const edJwk = { ...(await exportJWK(ed.publicKey)), kid: "ed-1", alg: "EdDSA" };
  return { rsa, ed, jwks: { keys: [rsaJwk, edJwk] } as Record<string, unknown> };
}

type SignKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const mint = (key: SignKey, alg: string, kid: string, claims: Record<string, unknown> = {}) =>
  new SignJWT({ scopes: ["read:notes"], ...claims })
    .setProtectedHeader({ alg, kid })
    .setSubject("alice")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

describe("asymmetric JWT (THE-297)", () => {
  it("verifies RS256 and EdDSA tokens against a kid'd JWKS (rotation-shaped set)", async () => {
    const { rsa, ed, jwks } = await makeKeys();
    const verifier = createTokenVerifier({ jwks });
    const idRsa = await verifier.verify(await mint(rsa.privateKey, "RS256", "rsa-1"));
    expect(idRsa.caller).toBe("alice");
    expect([...idRsa.scopes]).toContain("read:notes");
    const idEd = await verifier.verify(await mint(ed.privateKey, "EdDSA", "ed-1"));
    expect(idEd.caller).toBe("alice");
  });

  it("rejects a token signed by a key OUTSIDE the JWKS", async () => {
    const { jwks } = await makeKeys();
    const rogue = await generateKeyPair("RS256");
    const verifier = createTokenVerifier({ jwks });
    await expect(verifier.verify(await mint(rogue.privateKey, "RS256", "rsa-1"))).rejects.toThrow();
  });

  it("alg-confusion is structurally impossible: HS256 never verifies against the JWKS", async () => {
    const { jwks } = await makeKeys();
    const verifier = createTokenVerifier({ jwks }); // no secret configured
    // Attacker mints an HS256 token (using any secret) hoping the public key is misused as
    // the HMAC secret — the router rejects because no jwtSecret is configured at all.
    const hsToken = await new SignJWT({ scopes: ["*"] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("mallory")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a".repeat(32)));
    await expect(verifier.verify(hsToken)).rejects.toThrow(/no jwtSecret/);
  });

  it("the algorithms allowlist rejects algs outside it", async () => {
    const { rsa, jwks } = await makeKeys();
    const verifier = createTokenVerifier({ jwks, algorithms: ["EdDSA"] });
    await expect(verifier.verify(await mint(rsa.privateKey, "RS256", "rsa-1"))).rejects.toThrow();
  });

  it("still requires exp on asymmetric tokens", async () => {
    const { rsa, jwks } = await makeKeys();
    const verifier = createTokenVerifier({ jwks });
    const noExp = await new SignJWT({ scopes: [] })
      .setProtectedHeader({ alg: "RS256", kid: "rsa-1" })
      .setSubject("alice")
      .sign(rsa.privateKey);
    await expect(verifier.verify(noExp)).rejects.toThrow();
  });

  it("HS256 keeps working beside a JWKS when the secret IS configured", async () => {
    const { jwks } = await makeKeys();
    const secret = "s".repeat(32);
    const verifier = createTokenVerifier({ jwks, secret });
    const hs = await new SignJWT({ scopes: ["read:notes"] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("bob")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
    const id = await verifier.verify(hs);
    expect(id.caller).toBe("bob");
  });
});
