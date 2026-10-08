// Issuance-side bookkeeping for access tokens (design v2 sections 4.4, 4.8; slice S5a): the helper the
// token endpoint calls to record an issued access token's jti, and the guarantee that oauth.db
// housekeeping cannot orphan a token that is still live. The token's `exp` is a JWT NumericDate in
// SECONDS; the table and the registry hold epoch milliseconds, so a missing conversion would make the
// row look expired 1000x too early and the sweep would delete a live token's jti.
import { randomUUID } from "node:crypto";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { buildJwtVerifier } from "../src/auth/jwt-boot";
import { gcOauthDb, ISSUED_ACCESS_GC_GRACE_MS, recordIssuedAccess } from "../src/auth/oauth-db";
import { type AuthRegistry, authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { generateSigningKey, importSigningKey } from "../src/auth/signing-keys";
import { provisionAuthDb, provisionOauthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const ISSUER = "https://vault.example.com";
const RESOURCE = "https://vault.example.com/mcp";
// Real time: jose checks `iat`/`exp` against the wall clock, only the registry and GC take a fake one.
const NOW_S = Math.floor(Date.now() / 1000);
const NOW = NOW_S * 1000;
const LIFETIME_S = 1800;
const EXP_S = NOW_S + LIFETIME_S;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

const config = ServerConfigSchema.parse({
  vaults: [{ id: "v1", path: "/tmp/v1" }],
  auth: { mode: "jwt", resource: RESOURCE, as: { enabled: true, issuer: ISSUER } },
});

async function setup() {
  const dir = makeTempDir("issued-access-");
  dirs.push(dir);
  const authDb = openMemoryDb();
  provisionAuthDb(authDb);
  const clock = { t: NOW };
  const registry = createAuthRegistry(authDb, { keysDir: authKeysDir(dir), now: () => clock.t });
  registry.rotateKey({
    purpose: "as",
    alg: "ES256",
    generated: await generateSigningKey("ES256"),
    graceSeconds: 0,
  });
  const oauth = openMemoryDb();
  provisionOauthDb(oauth);
  oauth
    .prepare(
      "INSERT INTO grants (id, sub, client_id, redirect_uri, scope, resource, created_at) VALUES ('g1','u1','c1','https://c/cb','read:notes',?,1)",
    )
    .run(RESOURCE);
  return { registry, oauth, clock };
}

/** Sign an access token with the registry's `as` key, the way the token endpoint will. */
async function signAs(registry: AuthRegistry, jti: string, iat: number, exp: number) {
  const { kid, alg, secret } = registry.signingKey({ purpose: "as" });
  const token = await new SignJWT({
    iss: ISSUER,
    sub: "u1",
    aud: RESOURCE,
    client_id: "c1",
    scope: "read:notes",
    iat,
    exp,
    jti,
  })
    .setProtectedHeader({ alg, kid, typ: "at+jwt" })
    .sign(await importSigningKey(alg as "ES256", secret));
  return { token, kid };
}

const rec = (kid: string, jti: string, over: Record<string, unknown> = {}) => ({
  jti,
  kid,
  sub: "u1",
  scope: "read:notes",
  familyId: "fam1",
  grantId: "g1",
  iat: NOW_S,
  exp: EXP_S,
  ...over,
});
const issuedRows = (oauth: ReturnType<typeof openMemoryDb>) =>
  oauth.prepare("SELECT jti, family_id, grant_id, expires_at FROM issued_access").all();

describe("recordIssuedAccess", () => {
  it("records the jti with its family, grant and expiry (ms), and in the registry so token list/revoke see it", async () => {
    const { registry, oauth } = await setup();
    const jti = randomUUID();
    const { kid } = await signAs(registry, jti, NOW_S, EXP_S);
    recordIssuedAccess(oauth, registry, rec(kid, jti));
    expect(issuedRows(oauth)).toEqual([
      { jti, family_id: "fam1", grant_id: "g1", expires_at: EXP_S * 1000 },
    ]);
    const tokens = registry.listTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      jti,
      kid,
      sub: "u1",
      scopesSummary: "read:notes",
      issuedAt: NOW,
      expiresAt: EXP_S * 1000,
    });
  });

  it("refuses an `exp` that is epoch milliseconds, writing nothing anywhere", async () => {
    const { registry, oauth } = await setup();
    const { kid } = await signAs(registry, "j", NOW_S, EXP_S);
    expect(() => recordIssuedAccess(oauth, registry, rec(kid, "j", { exp: EXP_S * 1000 }))).toThrow(
      /seconds/,
    );
    expect(() => recordIssuedAccess(oauth, registry, rec(kid, "j", { exp: 1.5 }))).toThrow();
    expect(issuedRows(oauth)).toEqual([]);
    expect(registry.listTokens()).toEqual([]);
  });

  it("writes no oauth.db row when the registry record fails (a token that cannot be found by jti must not be issued)", async () => {
    const { registry, oauth } = await setup();
    const failing = {
      recordToken: () => {
        throw new Error("auth.db is read-only");
      },
    };
    expect(() => recordIssuedAccess(oauth, failing, rec("k", "j"))).toThrow(/read-only/);
    expect(issuedRows(oauth)).toEqual([]);
    expect(registry.listTokens()).toEqual([]);
  });
});

describe("oauth.db housekeeping cannot orphan a live access token", () => {
  const gc = (oauth: ReturnType<typeof openMemoryDb>, now: number) =>
    gcOauthDb(oauth, { now, dcrUnusedDays: 90 });

  it("GC at exp - 1s keeps the row", async () => {
    const { registry, oauth } = await setup();
    const { kid } = await signAs(registry, "j1", NOW_S, EXP_S);
    recordIssuedAccess(oauth, registry, rec(kid, "j1"));
    expect(gc(oauth, EXP_S * 1000 - 1000).issuedAccess).toBe(0);
    expect(issuedRows(oauth)).toHaveLength(1);
  });

  it("revoke-by-jti still works after a GC pass, and the verifier then rejects the token", async () => {
    const { registry, oauth, clock } = await setup();
    const jti = randomUUID();
    const { token, kid } = await signAs(registry, jti, NOW_S, EXP_S);
    recordIssuedAccess(oauth, registry, rec(kid, jti));
    const verifier = buildJwtVerifier(config.auth, registry);
    if (verifier === null) throw new Error("no verifier");
    // Near the end of the token's life: still valid, and a sweep runs.
    clock.t = EXP_S * 1000 - 1000;
    gc(oauth, EXP_S * 1000 - 1000);
    expect((await verifier.verify(token)).caller).toBe("u1");
    // Code replay: revoke every access token of the family, found through issued_access.
    const jtis = (
      oauth.prepare("SELECT jti FROM issued_access WHERE family_id = ?").all("fam1") as {
        jti: string;
      }[]
    ).map((r) => r.jti);
    expect(jtis).toEqual([jti]);
    for (const j of jtis) expect(registry.revoke(j, "code replay")).toBe("revoked");
    expect(registry.isRevoked(jti)).toBe(true);
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: "token_revoked" });
  });

  it("keeps the row through the verifier's clock skew, and removes it once exp + skew has passed", async () => {
    const { registry, oauth } = await setup();
    const { kid } = await signAs(registry, "j2", NOW_S, EXP_S);
    recordIssuedAccess(oauth, registry, rec(kid, "j2"));
    const expMs = EXP_S * 1000;
    // At exp itself, and one ms before the skew allowance ends: a replica whose clock lags still
    // accepts the token, so its jti must still be findable.
    expect(gc(oauth, expMs).issuedAccess).toBe(0);
    expect(gc(oauth, expMs + ISSUED_ACCESS_GC_GRACE_MS - 1).issuedAccess).toBe(0);
    expect(issuedRows(oauth)).toHaveLength(1);
    // Past exp + skew nothing can accept it any more.
    expect(gc(oauth, expMs + ISSUED_ACCESS_GC_GRACE_MS).issuedAccess).toBe(1);
    expect(issuedRows(oauth)).toEqual([]);
  });

  it("the grace is the design's 60 s skew", () => {
    expect(ISSUED_ACCESS_GC_GRACE_MS).toBe(60_000);
  });
});
