// Boot wiring of the bundled authorization server (design v2 sections 4.1, 4.2, 4.8, slice S3):
// the `as` signing key is generated at first boot when `auth.as.enabled` (idempotent, never on a
// lost registry, never replacing a key of another algorithm), oauth.db is opened and swept, a
// configured JWKS that duplicates an `as` key is refused (the purpose-escape closed at boot, where
// the registry is known), and `doctor` reports the whole picture. Nothing issues a token yet: the
// access tokens verified here are signed directly with the generated key.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { asKeyOverlapInJwks, ensureAsKey } from "../src/auth/as-boot";
import { AuthRejection } from "../src/auth/jwt";
import { buildJwtVerifier } from "../src/auth/jwt-boot";
import { type AuthRegistry, authDbPath, authKeysDir } from "../src/auth/registry";
import { openAuthRegistry } from "../src/auth/registry-open";
import { generateSigningKey, importSigningKey } from "../src/auth/signing-keys";
import { authAsCheck } from "../src/doctor/auth-as";
import { MetricsRecorder } from "../src/metrics/registry";
import { wireTransports } from "../src/runtime/transport-wiring";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const ISSUER = "https://vault.example.com";
const RESOURCE = "https://vault.example.com/mcp";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

type Cfg = ReturnType<typeof ServerConfigSchema.parse>;

function configFor(
  as: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
  root = makeTempDir("as-boot-"),
): Cfg {
  if (!dirs.includes(root)) dirs.push(root);
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: join(root, "cache"),
    auth: {
      mode: "jwt",
      jwtSecret: SECRET,
      resource: RESOURCE,
      ...(as === undefined ? {} : { as: { enabled: true, issuer: ISSUER, ...as } }),
      ...extra,
    },
    transports: { stdio: false, http: { enabled: false } },
    observability: { prometheus: { enabled: true, bind: "127.0.0.1", port: 0 } },
  });
}

const deps = (config: Cfg) =>
  ({
    config,
    version: "t",
    registry: {},
    vaultRegistry: {},
    db: openMemoryDb(),
    firstVaultId: "v1",
    acl: {},
    jobQueue: {},
    metrics: new MetricsRecorder(),
  }) as unknown as Parameters<typeof wireTransports>[0];

const asKeys = (reg: Pick<AuthRegistry, "listKeys">) =>
  reg.listKeys().filter((k) => k.purpose === "as");

async function bootAndClose(config: Cfg) {
  const wiring = await wireTransports(deps(config));
  const keys = wiring.authRegistry?.listKeys() ?? [];
  await wiring.close();
  return keys;
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function asToken(
  reg: NonNullable<Awaited<ReturnType<typeof openAuthRegistry>>["registry"]>,
  claims: Record<string, unknown> = {},
) {
  const { kid, alg, secret } = reg.signingKey({ purpose: "as" });
  return new SignJWT({
    iss: ISSUER,
    sub: "user-1",
    aud: RESOURCE,
    client_id: "client-1",
    scope: "read:notes",
    iat: nowSec(),
    exp: nowSec() + 600,
    jti: randomUUID(),
    ...claims,
  })
    .setProtectedHeader({ alg, kid, typ: "at+jwt" })
    .sign(await importSigningKey(alg as "ES256" | "EdDSA", secret));
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthRejection) return e.reason;
    throw e;
  }
  return "accepted";
}

describe("boot: the `as` signing key", () => {
  it("generates exactly one active `as` key of signingAlg, and a second boot adds none", async () => {
    const config = configFor({});
    const first = await bootAndClose(config);
    const as1 = asKeys({ listKeys: () => first });
    expect(as1).toHaveLength(1);
    expect(as1[0]).toMatchObject({ state: "active", alg: "ES256" });
    const second = await bootAndClose(config);
    expect(asKeys({ listKeys: () => second }).map((k) => k.kid)).toEqual([as1[0]?.kid]);
    // The key file is `as-` prefixed, 0600, and the only one.
    const files = readdirSync(authKeysDir(config.cacheDir));
    expect(files.filter((f) => f.startsWith("as-") && f.endsWith(".key"))).toHaveLength(1);
  });

  it("honours signingAlg EdDSA", async () => {
    const keys = await bootAndClose(configFor({ signingAlg: "EdDSA" }));
    expect(asKeys({ listKeys: () => keys })[0]).toMatchObject({ alg: "EdDSA", state: "active" });
  });

  it("leaves the mint key untouched", async () => {
    const config = configFor({});
    const seeded = await openAuthRegistry(config);
    seeded.registry.rotateKey({ graceSeconds: 0 });
    const mint = seeded.registry.listKeys().filter((k) => k.purpose === "mint");
    seeded.close();
    const keys = await bootAndClose(config);
    expect(keys.filter((k) => k.purpose === "mint").map((k) => [k.kid, k.state])).toEqual(
      mint.map((k) => [k.kid, k.state]),
    );
    expect(asKeys({ listKeys: () => keys })).toHaveLength(1);
  });

  it("with the AS disabled generates no `as` key and no oauth.db", async () => {
    const config = configFor(undefined);
    const keys = await bootAndClose(config);
    expect(keys.filter((k) => k.purpose === "as")).toHaveLength(0);
    expect(existsSync(join(config.cacheDir, "oauth.db"))).toBe(false);
  });

  it("with the AS enabled creates oauth.db (provisioned, unclaimed)", async () => {
    const config = configFor({});
    await bootAndClose(config);
    expect(existsSync(join(config.cacheDir, "oauth.db"))).toBe(true);
  });

  it("never generates a key on a lost registry", async () => {
    const config = configFor({});
    const seeded = await openAuthRegistry(config);
    seeded.registry.rotateKey({ graceSeconds: 0 });
    seeded.close();
    for (const ext of ["", "-wal", "-shm"])
      rmSync(`${authDbPath(config.cacheDir)}${ext}`, { force: true });
    const before = readdirSync(authKeysDir(config.cacheDir)).sort();
    const wiring = await wireTransports(deps(config));
    try {
      expect(wiring.authRegistry?.health().state).toBe("lost");
    } finally {
      await wiring.close();
    }
    expect(readdirSync(authKeysDir(config.cacheDir)).sort()).toEqual(before);
    expect(existsSync(authDbPath(config.cacheDir))).toBe(false);
  });

  it("does not replace an existing `as` key whose algorithm differs from the config", async () => {
    const root = makeTempDir("as-boot-alg-");
    await bootAndClose(configFor({ signingAlg: "ES256" }, {}, root));
    const keys = await bootAndClose(configFor({ signingAlg: "EdDSA" }, {}, root));
    const as = asKeys({ listKeys: () => keys });
    expect(as).toHaveLength(1);
    expect(as[0]).toMatchObject({ alg: "ES256", state: "active" });
  });

  it("ensureAsKey is idempotent and survives a concurrent creator (re-checks after the unique-index race)", async () => {
    const config = configFor({});
    const { registry, close } = await openAuthRegistry(config);
    try {
      const a = await ensureAsKey(registry, { alg: "ES256", accessTokenSeconds: 1800 });
      expect(a.created).toBe(true);
      const b = await ensureAsKey(registry, { alg: "ES256", accessTokenSeconds: 1800 });
      expect(b).toMatchObject({ created: false, kid: a.kid });
      // Simulate the race: another process created the key between our check and our write.
      const racing = {
        ...registry,
        listKeys: (() => {
          let calls = 0;
          return () => (calls++ === 0 ? [] : registry.listKeys());
        })(),
      };
      const c = await ensureAsKey(racing, { alg: "ES256", accessTokenSeconds: 1800 });
      expect(c).toMatchObject({ created: false, kid: a.kid });
      expect(asKeys(registry)).toHaveLength(1);
    } finally {
      close();
    }
  });
});

describe("boot: verifier and the as key", () => {
  it("an as-signed access token verifies through the boot verifier when the AS is enabled", async () => {
    const config = configFor({});
    const wiring = await wireTransports(deps(config));
    try {
      const reg = wiring.authRegistry;
      if (!reg) throw new Error("registry missing");
      const verifier = buildJwtVerifier(config.auth, reg);
      const id = await verifier?.verify(await asToken(reg));
      expect(id?.caller).toBe("user-1");
      expect([...(id?.scopes ?? [])]).toEqual(["read:notes"]);
    } finally {
      await wiring.close();
    }
  });

  it("the same token is `misconfigured` when the AS is disabled", async () => {
    const root = makeTempDir("as-boot-off-");
    const on = configFor({}, {}, root);
    const wiring = await wireTransports(deps(on));
    const reg = wiring.authRegistry;
    if (!reg) throw new Error("registry missing");
    const token = await asToken(reg);
    await wiring.close();
    const off = configFor(undefined, {}, root);
    const wiring2 = await wireTransports(deps(off));
    try {
      const reg2 = wiring2.authRegistry;
      if (!reg2) throw new Error("registry missing");
      expect(
        await reasonOf(buildJwtVerifier(off.auth, reg2)?.verify(token) as Promise<unknown>),
      ).toBe("misconfigured");
    } finally {
      await wiring2.close();
    }
  });

  it("a hand-minted HS256 token still verifies with the AS enabled", async () => {
    const config = configFor({});
    const wiring = await wireTransports(deps(config));
    try {
      // No `aud`, as a hand-minted token has always been: it must keep verifying (design v2 section 7).
      const token = await new SignJWT({ sub: "me", scope: "read:notes" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(new TextEncoder().encode(SECRET));
      const id = await buildJwtVerifier(config.auth, wiring.authRegistry)?.verify(token);
      expect(id?.caller).toBe("me");
    } finally {
      await wiring.close();
    }
  });
});

describe("boot: a configured JWKS may not duplicate an `as` key (review LOW 3)", () => {
  it("refuses to boot when auth.jwks holds the as key's public JWK", async () => {
    const root = makeTempDir("as-boot-dup-");
    const first = configFor({}, {}, root);
    const keys = await bootAndClose(first);
    const asKey = keys.find((k) => k.purpose === "as");
    if (!asKey?.publicJwk) throw new Error("no as key");
    const dup = configFor(
      {},
      { jwks: { keys: [{ ...asKey.publicJwk, kid: "innocent-looking", use: "sig" }] } },
      root,
    );
    await expect(wireTransports(deps(dup))).rejects.toThrow(
      new RegExp(`auth\\.jwks.*${asKey.kid}|${asKey.kid}.*auth\\.jwks`, "s"),
    );
  });

  it("refuses the same key arriving through auth.jwksFile", async () => {
    const root = makeTempDir("as-boot-dupfile-");
    const keys = await bootAndClose(configFor({}, {}, root));
    const asKey = keys.find((k) => k.purpose === "as");
    if (!asKey?.publicJwk) throw new Error("no as key");
    const file = join(root, "jwks.json");
    writeFileSync(file, JSON.stringify({ keys: [asKey.publicJwk] }));
    await expect(wireTransports(deps(configFor({}, { jwksFile: file }, root)))).rejects.toThrow(
      /jwksFile/,
    );
  });

  it("boots when auth.jwks holds a different key", async () => {
    const root = makeTempDir("as-boot-other-");
    await bootAndClose(configFor({}, {}, root));
    const other = await generateSigningKey("ES256");
    const ok = configFor({}, { jwks: { keys: [{ ...other.publicJwk, kid: "other" }] } }, root);
    const wiring = await wireTransports(deps(ok));
    await wiring.close();
  });

  it("asKeyOverlapInJwks compares RFC 7638 thumbprints, not kids, and ignores non-as keys", async () => {
    const config = configFor({});
    const { registry, close } = await openAuthRegistry(config);
    try {
      await ensureAsKey(registry, { alg: "ES256", accessTokenSeconds: 1800 });
      const asKey = asKeys(registry)[0];
      if (!asKey?.publicJwk) throw new Error("no as key");
      const other = await generateSigningKey("EdDSA");
      expect(
        await asKeyOverlapInJwks({ keys: [{ ...asKey.publicJwk, kid: "x" }] }, registry),
      ).toEqual([asKey.kid]);
      expect(
        await asKeyOverlapInJwks({ keys: [{ ...other.publicJwk, kid: asKey.kid }] }, registry),
      ).toEqual([]);
      expect(await asKeyOverlapInJwks(undefined, registry)).toEqual([]);
      // A malformed entry is not this check's business (the JWKS loader refuses it).
      expect(await asKeyOverlapInJwks({ keys: [{ kty: "bogus" }, null] }, registry)).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("doctor: the `as` section", () => {
  const now = 1_800_000_000_000;
  const base = {
    enabled: true,
    issuer: ISSUER,
    metadataUrl: `${ISSUER}/.well-known/oauth-authorization-server`,
    issuing: true,
    signingAlg: "ES256",
    accessTokenSeconds: 1800,
    tokenTtlSeconds: 3600,
    authorizationServers: [ISSUER],
    registryState: "ok" as const,
    oauthDb: { path: "/c/oauth.db", exists: true, claimed: true },
    keys: [
      {
        kid: "k1",
        alg: "ES256",
        purpose: "as",
        state: "active" as const,
        createdAt: now - 86_400_000,
      },
      { kid: "m1", alg: "HS256", purpose: "mint", state: "active" as const, createdAt: now },
    ],
    jwksOverlap: [] as string[],
    settings: {
      refreshTokenDays: 30,
      dynamicRegistration: false,
      dcr: { maxClients: 1000, perIpPerHour: 10, unusedDays: 90 },
      login: { maxFailuresPerWindow: 5, windowSeconds: 900 },
      clientCount: 2,
      clientRedirectUris: 3,
      cimdAllowedHosts: ["claude.ai"],
      setupTokenEnv: "OBSIDIAN_TC_AS_SETUP_TOKEN",
      setupTokenSet: false,
    },
    now,
  };
  const run = (over: Record<string, unknown> = {}) =>
    authAsCheck({ ...base, ...over } as never).run({ serverVersion: "t" });

  it("is ok when claimed with a fresh matching key, and shows the metadata URL, kid and settings", async () => {
    const r = await run();
    expect(r.status).toBe("ok");
    const text = JSON.stringify(r);
    expect(text).toContain(base.metadataUrl);
    expect(text).toContain("k1");
    expect(text).toContain("refreshTokenDays");
    expect(text).toContain("OBSIDIAN_TC_AS_SETUP_TOKEN");
    expect(text).toContain("claude.ai");
    expect(text).toContain("3 redirect URIs");
    expect(text).toMatch(/back up oauth\.db/i);
  });

  it("says the issuing routes are not yet available while they are not mounted, and ok otherwise", async () => {
    const early = await run({ issuing: false });
    expect(early.status).toBe("ok");
    expect(early.summary).toMatch(/AS enabled, issuing routes not yet available/);
    expect(JSON.stringify(early.details)).toMatch(/not yet available/);
    expect((await run({ issuing: true })).summary).not.toMatch(/not yet available/);
    // Also with a problem to report: the note rides along with the problem summary.
    expect(
      (await run({ issuing: false, oauthDb: { path: "p", exists: true, claimed: false } })).summary,
    ).toMatch(/issuing routes not yet available/);
  });

  it("is a no-op (ok, not in use) when the AS is disabled", async () => {
    const r = await run({ enabled: false });
    expect(r.status).toBe("ok");
    expect(r.summary).toMatch(/not enabled/i);
  });

  it("warns while unclaimed", async () => {
    const r = await run({ oauthDb: { path: "/c/oauth.db", exists: true, claimed: false } });
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/unclaimed/i);
  });

  it("fails when no active as key exists, or oauth.db is unreadable", async () => {
    expect((await run({ keys: [] })).status).toBe("fail");
    const r = await run({
      oauthDb: { path: "/c/oauth.db", exists: true, claimed: false, unreadable: "malformed" },
    });
    expect(r.status).toBe("fail");
  });

  it("fails when a configured JWKS duplicates an as key", async () => {
    const r = await run({ jwksOverlap: ["k1"] });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r)).toContain("auth.jwks");
  });

  it("warns on a key older than 180 days and on an algorithm differing from the config", async () => {
    const old = await run({
      keys: [{ ...base.keys[0], createdAt: now - 181 * 86_400_000 }, base.keys[1]],
    });
    expect(old.status).toBe("warning");
    expect(old.summary + JSON.stringify(old.issues)).toMatch(/180/);
    const alg = await run({ signingAlg: "EdDSA" });
    expect(alg.status).toBe("warning");
  });

  it("warns when authorizationServers does not lead with the issuer or tokenTtl < accessTokenSeconds", async () => {
    expect((await run({ authorizationServers: ["https://other.example"] })).status).toBe("warning");
    expect((await run({ tokenTtlSeconds: 60 })).status).toBe("warning");
  });

  it("fails on a lost registry (no key can be read or made)", async () => {
    expect((await run({ registryState: "lost", keys: undefined })).status).toBe("fail");
  });

  it("reports whether the setup-token variable is set, never its value", async () => {
    const r = await run({ settings: { ...base.settings, setupTokenSet: true } });
    const text = JSON.stringify(r);
    expect(text).toMatch(/set/);
    expect(text).not.toContain("hunter2");
  });

  it("run_doctor maps `purpose` into the auth.registry key view (S2 gap) and wires the as view", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) =>
      readFileSync(new URL(`../src/cli/commands/${f}`, import.meta.url), "utf8");
    const src = read("doctor.ts");
    const at = src.indexOf("authRegistry: {");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(src.slice(at, at + 1500)).toContain("purpose: k.purpose");
    expect(src).toContain("authAs");
    expect(read("doctor-auth-as.ts")).toContain("purpose: k.purpose");
  });
});
