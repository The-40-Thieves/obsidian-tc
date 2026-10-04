// PINS today's behaviour of `auth.resource` WITHOUT `auth.authorizationServers` on a JWKS-backed jwt
// server, so the planned alignment is a visible change in this file rather than a silent one.
//
// The config schema (server.schema.ts) counts `resource` alone as satisfying "bind an audience",
// but the verifier (protected-resource.ts effectiveAudience) uses `resource` as the audience only
// when Protected Resource Metadata is complete (authorizationServers too). So the config loads and
// no `aud` is enforced; the missing-audience deprecation is the only signal. In the next minor
// release, when that deprecation becomes a startup error, the two are to be aligned and the
// expectations below flip (the schema or the verifier changes).
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { buildJwtVerifier } from "../src/auth/jwt-boot";
import { effectiveAudience, jwksWithoutAudience } from "../src/auth/protected-resource";

const parse = (a: Record<string, unknown>) =>
  ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", ...a },
  });

describe("auth.resource alone (no authorizationServers) with a JWKS: current behaviour", () => {
  it("the schema accepts it as if an audience were bound", async () => {
    const { publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA" }] };
    expect(() => parse({ jwks, resource: "https://r.example/mcp" })).not.toThrow();
  });

  it("the verifier binds no audience from it", () => {
    const { auth } = parse({
      jwksUri: "https://as.example/jwks",
      resource: "https://r.example/mcp",
    });
    expect(effectiveAudience(auth)).toBeUndefined();
    expect(jwksWithoutAudience(auth)).toBe(true);
  });

  it("a token minted for ANOTHER audience is accepted", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA" }] };
    const v = buildJwtVerifier(parse({ jwks, resource: "https://r.example/mcp" }).auth);
    const tok = await new SignJWT({ sub: "a" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setAudience("https://some-other-service.example")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect((v as NonNullable<typeof v>).verify(tok)).resolves.toMatchObject({ caller: "a" });
  });

  it("with authorizationServers too, the resource IS the audience (the aligned shape)", () => {
    const { auth } = parse({
      jwksUri: "https://as.example/jwks",
      resource: "https://r.example/mcp",
      authorizationServers: ["https://as.example"],
    });
    expect(effectiveAudience(auth)).toBe("https://r.example/mcp");
    expect(jwksWithoutAudience(auth)).toBe(false);
  });
});
