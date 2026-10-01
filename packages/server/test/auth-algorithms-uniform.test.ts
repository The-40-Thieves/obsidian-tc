import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { AuthRejection } from "../src/auth/jwt";
import { buildJwtVerifier } from "../src/auth/jwt-boot";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { generateSigningKey } from "../src/auth/signing-keys";
import { createTokenVerifier } from "../src/auth/verifier";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { provisionAuthDb } from "../src/db/provision";
import { createMetricsApp } from "../src/metrics/endpoint";
import { MetricsRecorder } from "../src/metrics/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

const now = () => Math.floor(Date.now() / 1000);
const claims = () => ({
  sub: "agent",
  scopes: ["read:notes", "admin:metrics"],
  iat: now(),
  exp: now() + 600,
});
const hs256 = (kid?: string) =>
  new SignJWT(claims())
    .setProtectedHeader({ alg: "HS256", ...(kid ? { kid } : {}) })
    .sign(new TextEncoder().encode(SECRET));

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthRejection) return e.reason;
    throw e;
  }
  return "accepted";
}

function registryFixture() {
  const db = openMemoryDb();
  provisionAuthDb(db);
  const dir = makeTempDir("auth-algs-");
  dirs.push(dir);
  return createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(dir) });
}

describe("auth.algorithms applies to the HS256 branch of the verifier", () => {
  it("refuses an HS256 token against the configured secret when HS256 is not allowed", async () => {
    const v = createTokenVerifier({ secret: SECRET, algorithms: ["EdDSA"] });
    expect(await reasonOf(v.verify(await hs256()))).toBe("unsupported_alg");
  });

  it("refuses an HS256 token against a registry HS256 key (config key) when HS256 is not allowed", async () => {
    const registry = registryFixture();
    const v = createTokenVerifier({ secret: SECRET, registry, algorithms: ["ES256", "EdDSA"] });
    expect(await reasonOf(v.verify(await hs256()))).toBe("unsupported_alg");
  });

  it("refuses an HS256 token against a rotated HS256 registry key when HS256 is not allowed", async () => {
    const registry = registryFixture();
    const rotated = registry.rotateKey({ alg: "HS256", graceSeconds: 0 });
    const token = await signAndRecord(registry, claims());
    const open = createTokenVerifier({ registry });
    expect(await reasonOf(open.verify(token))).toBe("accepted");
    expect(rotated.kid).toBeTruthy();
    const narrowed = createTokenVerifier({ registry, algorithms: ["EdDSA"] });
    expect(await reasonOf(narrowed.verify(token))).toBe("unsupported_alg");
  });

  it("still accepts HS256 when it is listed, and with no allowlist at all (default unchanged)", async () => {
    expect(
      await reasonOf(
        createTokenVerifier({ secret: SECRET, algorithms: ["HS256", "EdDSA"] }).verify(
          await hs256(),
        ),
      ),
    ).toBe("accepted");
    expect(await reasonOf(createTokenVerifier({ secret: SECRET }).verify(await hs256()))).toBe(
      "accepted",
    );
  });

  it("refuses by allowlist before the key lookup: no secret and no registry is still unsupported_alg", async () => {
    const v = createTokenVerifier({ algorithms: ["EdDSA"] });
    expect(await reasonOf(v.verify(await hs256()))).toBe("unsupported_alg");
  });
});

describe("auth.algorithms applies to the JWKS path", () => {
  it("accepts an EdDSA token and refuses an ES256 token from the same JWKS under ['EdDSA']", async () => {
    const ed = await generateKeyPair("EdDSA");
    const es = await generateKeyPair("ES256");
    const jwks = {
      keys: [
        { ...(await exportJWK(ed.publicKey)), kid: "ed", alg: "EdDSA", use: "sig" },
        { ...(await exportJWK(es.publicKey)), kid: "es", alg: "ES256", use: "sig" },
      ],
    };
    const sign = (alg: string, kid: string, key: Parameters<SignJWT["sign"]>[0]) =>
      new SignJWT(claims()).setProtectedHeader({ alg, kid }).sign(key);
    const v = createTokenVerifier({ jwks, algorithms: ["EdDSA"] });
    expect(await reasonOf(v.verify(await sign("EdDSA", "ed", ed.privateKey)))).toBe("accepted");
    expect(await reasonOf(v.verify(await sign("ES256", "es", es.privateKey)))).toBe(
      "unsupported_alg",
    );
    // HS256 is never routed to the JWKS; with the list in force it is refused outright.
    expect(await reasonOf(v.verify(await hs256()))).toBe("unsupported_alg");
  });
});

describe("/metrics applies auth.algorithms", () => {
  const scrape = (app: ReturnType<typeof createMetricsApp>, token: string) =>
    app.request("/metrics", { headers: { authorization: `Bearer ${token}` } });
  const base = {
    tokenTtlSeconds: 86400,
    rotationGraceSeconds: 0,
    requireJti: false,
  };

  it("refuses an HS256 scrape token under ['EdDSA'], and accepts it with no allowlist", async () => {
    const openAuth = { mode: "jwt", jwtSecret: SECRET, ...base } as const;
    const open = createMetricsApp({
      recorder: new MetricsRecorder(),
      bind: "0.0.0.0",
      port: 0,
      auth: openAuth,
      verifier: buildJwtVerifier(openAuth) ?? undefined,
    });
    expect((await scrape(open, await hs256())).status).toBe(200);
    const narrowedAuth = {
      mode: "jwt",
      jwtSecret: SECRET,
      algorithms: ["EdDSA"] as string[],
      ...base,
    } as const;
    const narrowed = createMetricsApp({
      recorder: new MetricsRecorder(),
      bind: "0.0.0.0",
      port: 0,
      auth: narrowedAuth,
      verifier: buildJwtVerifier(narrowedAuth) ?? undefined,
    });
    expect((await scrape(narrowed, await hs256())).status).toBe(401);
  });

  it("refuses a registry asymmetric key outside the list, accepts one inside it", async () => {
    const registry = registryFixture();
    await registry.rotateKey({
      alg: "EdDSA",
      generated: await generateSigningKey("EdDSA"),
      graceSeconds: 0,
    });
    const token = await signAndRecord(registry, claims());
    const build = (algorithms: string[]) => {
      const auth = { mode: "jwt", jwtSecret: SECRET, algorithms, ...base } as const;
      return createMetricsApp({
        recorder: new MetricsRecorder(),
        bind: "0.0.0.0",
        port: 0,
        auth,
        verifier: buildJwtVerifier(auth, registry) ?? undefined,
      });
    };
    expect((await scrape(build(["EdDSA"]), token)).status).toBe(200);
    expect((await scrape(build(["ES256"]), token)).status).toBe(401);
  });
});
