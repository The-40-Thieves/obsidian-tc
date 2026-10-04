// Review follow-ups to the key-purpose slice (S2), closed before any slice issues `as` tokens:
//  1. an `as` token must carry a non-empty string `sub` and `jti`, a finite numeric `iat` and a
//     string `client_id`: jose's requiredClaims only checks PRESENCE, so `"jti": 1` used to pass and
//     then be silently treated as jti-less (never revocable);
//  2. an unqualified scope word (`read`, which parseScope reads as the wildcard `read:*`) on the `as`
//     path grants nothing, as on the OIDC path;
//  4. `asGraceFloorSeconds` refuses a non-finite or non-positive access-token lifetime.
// (Item 3, the duplicate-key purpose escape, lives in auth-as-boot.test.ts.)
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { narrowToTokenScopes } from "../src/auth/persona";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { asGraceFloorSeconds, generateSigningKey, importSigningKey } from "../src/auth/signing-keys";
import { createTokenVerifier } from "../src/auth/verifier";
import { provisionAuthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const AS_ISS = "https://vault.example.com";
const RESOURCE = "https://vault.example.com/mcp";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

async function fixture() {
  const db = openMemoryDb();
  provisionAuthDb(db);
  const dir = makeTempDir("auth-as-claims-");
  dirs.push(dir);
  const registry = createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(dir) });
  registry.rotateKey({
    purpose: "as",
    alg: "ES256",
    generated: await generateSigningKey("ES256"),
  } as never);
  const verifier = createTokenVerifier({
    secret: SECRET,
    registry,
    asIssuer: AS_ISS,
    resource: RESOURCE,
    audience: RESOURCE,
  });
  const nowSec = Math.floor(Date.now() / 1000);
  // `undefined` removes a claim.
  const token = async (claims: Record<string, unknown>) => {
    const k = registry.signingKey({ purpose: "as" } as never);
    return new SignJWT({
      iss: AS_ISS,
      sub: "user-1",
      aud: RESOURCE,
      client_id: "client-1",
      scope: "read:notes",
      iat: nowSec,
      exp: nowSec + 600,
      jti: randomUUID(),
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: k.kid, typ: "at+jwt" })
      .sign(await importSigningKey("ES256", k.secret));
  };
  return { verifier, token };
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "accepted";
  } catch (e) {
    return (e as { reason?: string }).reason ?? String(e);
  }
}

describe("an `as` token's identity claims are validated by TYPE, not just presence", () => {
  it("accepts a well-formed token", async () => {
    const f = await fixture();
    const id = await f.verifier.verify(await f.token({}));
    expect(id.caller).toBe("user-1");
    expect(id.keyPurpose).toBe("as");
  });

  it('RED repro: `"jti": 1` with no `sub` and no `iat` is rejected', async () => {
    const f = await fixture();
    const t = await f.token({ jti: 1, sub: undefined, iat: undefined });
    expect(await outcome(f.verifier.verify(t))).not.toBe("accepted");
  });

  it.each([
    ["a numeric jti", { jti: 1 }],
    ["an empty jti", { jti: "" }],
    ["an object jti", { jti: { a: 1 } }],
    ["a missing sub", { sub: undefined }],
    ["an empty sub", { sub: "" }],
    ["a numeric sub", { sub: 7 }],
    ["a missing iat", { iat: undefined }],
    ["a numeric client_id", { client_id: 5 }],
    ["an empty client_id", { client_id: "" }],
  ])("rejects %s", async (_name, claims) => {
    const f = await fixture();
    expect(await outcome(f.verifier.verify(await f.token(claims)))).toBe("missing_claim");
  });

  it("rejects a string iat (jose refuses it as malformed before our own check)", async () => {
    const f = await fixture();
    const t = await f.token({ iat: "1700000000" });
    expect(await outcome(f.verifier.verify(t))).toBe("malformed");
  });
});

describe("an unqualified scope word on the `as` path grants nothing", () => {
  it("keeps qualified scopes and drops a bare family word", async () => {
    const f = await fixture();
    const id = await f.verifier.verify(
      await f.token({ scope: "read read:notes admin write:* openid" }),
    );
    expect([...id.scopes].sort()).toEqual(["read:notes", "write:*"]);
  });

  it("persona read:notes+read:secrets with token scope=read is granted nothing", async () => {
    const f = await fixture();
    const id = await f.verifier.verify(await f.token({ scope: "read" }));
    const granted = narrowToTokenScopes(new Set(["read:notes", "read:secrets"]), id.scopes);
    expect([...granted]).toEqual([]);
  });
});

describe("asGraceFloorSeconds", () => {
  it("is lifetime plus 60 s skew for a valid lifetime, and 1860 by default", () => {
    expect(asGraceFloorSeconds(300)).toBe(360);
    expect(asGraceFloorSeconds()).toBe(1860);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["zero", 0],
    ["a negative lifetime", -30],
  ])("refuses %s", (_name, v) => {
    expect(() => asGraceFloorSeconds(v)).toThrow(/access.?token/i);
  });
});
