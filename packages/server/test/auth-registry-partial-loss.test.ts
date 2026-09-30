// Round-2 review of the auth registry: health is judged PER TABLE, an empty or symlinked
// auth-keys/ is refused, and a failed first write can never delete a marker another connection has
// already committed a row under.
//
// The registry keeps two durable markers beside the key files, OUTSIDE auth.db: `.keys-initialized`
// (a key was ever rotated in) and `.tokens-initialized` (a token or revocation was ever written).
// One table emptying while the other survives is a stale restore or table-level damage, and reading
// either as "never used" would revive a retired key or un-revoke every revoked jti.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { AuthRejection } from "../src/auth/jwt";
import {
  authDbPath,
  authKeysDir,
  createAuthRegistry,
  registryInitialized,
} from "../src/auth/registry";
import { openAuthRegistry, probeAuthRegistry } from "../src/auth/registry-open";
import { createTokenVerifier } from "../src/auth/verifier";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { openDatabase } from "../src/db/open";
import { provisionAuthDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "auth-partial-"));
  dirs.push(dir);
  return dir;
};
const claims = () => {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "agent-1", scopes: ["read:notes"], iat: now, exp: now + 3600 };
};
const legacyToken = (extra: Record<string, unknown> = {}, kid?: string) =>
  new SignJWT({ ...claims(), ...extra })
    .setProtectedHeader({ alg: "HS256", ...(kid !== undefined ? { kid } : {}) })
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
const cfgFor = (cacheDir: string) =>
  ({
    cacheDir,
    db: { busyTimeoutMs: 5000 },
    auth: { mode: "jwt" as const, jwtSecret: SECRET },
  }) as never;

/** A registry over an in-memory auth.db, sharing `dir`'s auth-keys directory. */
function memoryRegistry(dir: string) {
  const db = openMemoryDb();
  provisionAuthDb(db);
  return { db, reg: createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(dir) }) };
}
const verifierOf = (reg: ReturnType<typeof createAuthRegistry>) =>
  createTokenVerifier({ secret: SECRET, registry: reg });

describe("partial loss: one registry table emptied while the other survives", () => {
  it("(a) auth_keys emptied, token rows survive: the retired config key is NOT revived", async () => {
    const dir = freshDir();
    const { db, reg } = memoryRegistry(dir);
    reg.rotateKey(); // config -> retired, k_... active
    const minted = await signAndRecord(reg, claims());
    expect(await reasonOf(verifierOf(reg).verify(await legacyToken()))).toBe("key_retired");
    expect(await reasonOf(verifierOf(reg).verify(minted))).toBe("accepted");

    db.exec("DELETE FROM auth_keys");
    expect(db.prepare("SELECT count(*) AS n FROM auth_tokens").get()).toEqual({ n: 1 });

    expect(reg.health().state).toBe("lost");
    expect(await reasonOf(verifierOf(reg).verify(await legacyToken()))).toBe("registry_lost");
    expect(await reasonOf(verifierOf(reg).verify(await legacyToken({}, "k_arbitrary")))).toBe(
      "registry_lost",
    );
    expect(await reasonOf(verifierOf(reg).verify(minted))).toBe("registry_lost");
    expect(() => reg.signingKey()).toThrow(/auth\.db/);
  });

  it("(a2) auth_keys emptied: an asymmetric token falls through to NEITHER a configured JWKS nor a remote set", async () => {
    const dir = freshDir();
    const { db, reg } = memoryRegistry(dir);
    reg.rotateKey(); // initialises the keys marker
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "ext-1", alg: "ES256", use: "sig" };
    const es = (kid?: string) =>
      new SignJWT(claims())
        .setProtectedHeader({ alg: "ES256", ...(kid !== undefined ? { kid } : {}) })
        .sign(privateKey);
    const verifier = createTokenVerifier({ jwks: { keys: [jwk] }, registry: reg });
    // Healthy registry, kid it does not hold: the external JWKS verifies it, as before.
    expect(await reasonOf(verifier.verify(await es("ext-1")))).toBe("accepted");

    db.exec("DELETE FROM auth_keys");
    expect(reg.health().state).toBe("lost");
    for (const kid of ["ext-1", "k_retired_asymmetric", undefined]) {
      expect(await reasonOf(verifier.verify(await es(kid)))).toBe("registry_lost");
    }
    // The remote-set path (jose fetches a jwksUri) is behind the same guard: it must refuse before
    // any fetch is attempted.
    const remote = createTokenVerifier({
      jwksUri: "http://127.0.0.1:9/never-fetched",
      registry: reg,
    });
    expect(await reasonOf(remote.verify(await es("ext-1")))).toBe("registry_lost");
  });

  it("(b) auth_tokens emptied, key rows survive: a revoked jti is NOT read as live", async () => {
    const dir = freshDir();
    const { db, reg } = memoryRegistry(dir);
    reg.rotateKey();
    const minted = await signAndRecord(reg, claims());
    const jti = reg.listTokens()[0]?.jti as string;
    expect(reg.revoke(jti, "compromised")).toBe("revoked");
    expect(await reasonOf(verifierOf(reg).verify(minted))).toBe("token_revoked");

    db.exec("DELETE FROM auth_tokens");
    expect(db.prepare("SELECT count(*) AS n FROM auth_keys").get()).toEqual({ n: 2 });

    expect(reg.health().state).toBe("lost");
    expect(() => reg.isRevoked(jti)).toThrow(/registry_lost/);
    expect(await reasonOf(verifierOf(reg).verify(minted))).toBe("registry_lost");
    expect(() => reg.revoke("x", null)).toThrow(/auth\.db/);
    expect(() => reg.rotateKey()).toThrow(/auth\.db/);
  });

  it("tokens were written but keys never rotated, then auth_tokens emptied: lost, not 'nothing revoked'", async () => {
    const dir = freshDir();
    const { db, reg } = memoryRegistry(dir);
    expect(reg.revoke("some-external-jti", "compromised")).toBe("tombstoned");
    db.exec("DELETE FROM auth_tokens");
    expect(reg.health().state).toBe("lost");
    expect(() => reg.isRevoked("some-external-jti")).toThrow(/registry_lost/);
  });

  it("the legacy jwtSecret path applies only while keys were NEVER initialised", async () => {
    const dir = freshDir();
    const { reg } = memoryRegistry(dir);
    await signAndRecord(reg, claims()); // tokens initialised, keys never
    expect(await reasonOf(verifierOf(reg).verify(await legacyToken()))).toBe("accepted");
    expect(existsSync(join(authKeysDir(dir), ".tokens-initialized"))).toBe(true);
    expect(existsSync(join(authKeysDir(dir), ".keys-initialized"))).toBe(false);
  });

  it("rotation alone writes only the keys marker; an emptied auth_tokens is then not lost (nothing was ever revoked)", async () => {
    const dir = freshDir();
    const { db, reg } = memoryRegistry(dir);
    reg.rotateKey();
    expect(existsSync(join(authKeysDir(dir), ".keys-initialized"))).toBe(true);
    expect(existsSync(join(authKeysDir(dir), ".tokens-initialized"))).toBe(false);
    db.exec("DELETE FROM auth_tokens");
    expect(reg.health().state).toBe("ok");
    expect(reg.isRevoked("anything")).toBe(false);
  });
});

describe("symlinked auth-keys directory", () => {
  const skip = process.platform === "win32";

  function symlinkedKeysDir(cacheDir: string): string {
    const elsewhere = join(freshDir(), "empty-target");
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(cacheDir, { recursive: true });
    symlinkSync(elsewhere, authKeysDir(cacheDir), "dir");
    return elsewhere;
  }

  it.skipIf(skip)("is initialised (refused), never read as 'nothing here'", () => {
    const cacheDir = freshDir();
    symlinkedKeysDir(cacheDir);
    expect(registryInitialized(authKeysDir(cacheDir))).toBe(true);
  });

  it.skipIf(skip)(
    "openAuthRegistry with auth.db missing is lost and does NOT create auth.db",
    async () => {
      const cacheDir = freshDir();
      symlinkedKeysDir(cacheDir);
      const { registry, close } = await openAuthRegistry(cfgFor(cacheDir));
      try {
        const h = registry.health();
        expect(h.state).toBe("lost");
        if (h.state === "lost") expect(h.detail).toMatch(/symlink/);
        expect(existsSync(authDbPath(cacheDir))).toBe(false);
        expect(await reasonOf(verifierOf(registry).verify(await legacyToken()))).toBe(
          "registry_lost",
        );
      } finally {
        close();
      }
    },
  );

  it.skipIf(skip)(
    "an existing empty auth.db behind a symlinked auth-keys is lost too",
    async () => {
      const cacheDir = freshDir();
      const first = await openAuthRegistry(cfgFor(cacheDir)); // creates an empty, migrated auth.db
      first.close();
      symlinkedKeysDir(cacheDir);
      const second = await openAuthRegistry(cfgFor(cacheDir));
      try {
        expect(second.registry.health().state).toBe("lost");
      } finally {
        second.close();
      }
    },
  );

  it.skipIf(skip)(
    "doctor's probe reports it: lost, and the directory named as an issue",
    async () => {
      const cacheDir = freshDir();
      symlinkedKeysDir(cacheDir);
      const probe = await probeAuthRegistry(cfgFor(cacheDir));
      expect(probe.health.state).toBe("lost");
      expect(probe.keyFileIssues.join(" ")).toMatch(/symlink/);
    },
  );

  it("a regular FILE where auth-keys/ should be is refused the same way", async () => {
    const cacheDir = freshDir();
    writeFileSync(authKeysDir(cacheDir), "not a directory");
    expect(registryInitialized(authKeysDir(cacheDir))).toBe(true);
    const probe = await probeAuthRegistry(cfgFor(cacheDir));
    expect(probe.health.state).toBe("lost");
    expect(probe.keyFileIssues.length).toBeGreaterThan(0);
  });
});

describe("concurrent first writes and the durable marker", () => {
  /** Wrap `db` so COMMIT fails once, and `afterRollback` runs right after the ROLLBACK that follows. */
  function failingCommit(db: Database, afterRollback?: () => void): Database {
    let failed = false;
    let fired = false;
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "exec") {
          return (sql: string) => {
            const s = sql.trim().toUpperCase();
            if (s === "COMMIT" && !failed) {
              failed = true;
              throw new Error("disk I/O error (injected)");
            }
            const r = (target as Database).exec(sql);
            if (s === "ROLLBACK" && failed && !fired) {
              fired = true;
              afterRollback?.();
            }
            return r;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }
  const markers = (dir: string): string[] => {
    try {
      return readdirSync(authKeysDir(dir)).filter((n) => n.startsWith("."));
    } catch {
      return [];
    }
  };
  const tokenRec = (jti: string) => ({
    jti,
    kid: "config",
    sub: null,
    scopesSummary: "",
    issuedAt: 1,
    expiresAt: 2,
  });

  it("a commit failure with no other writer leaves no marker (no self-lockout)", async () => {
    const cacheDir = freshDir();
    const raw = await openDatabase(authDbPath(cacheDir));
    provisionAuthDb(raw);
    const reg = createAuthRegistry(failingCommit(raw), {
      configSecret: SECRET,
      keysDir: authKeysDir(cacheDir),
    });
    expect(() => reg.recordToken(tokenRec("j1"))).toThrow(/injected/);
    expect(markers(cacheDir)).toEqual([]);
    expect(registryInitialized(authKeysDir(cacheDir))).toBe(false);
    // and the deployment is still usable on the legacy path, and can write again
    expect(reg.health().state).toBe("uninitialised");
    reg.recordToken(tokenRec("j2"));
    expect(markers(cacheDir)).toEqual([".tokens-initialized"]);
    raw.close?.();
  });

  it("another connection commits its first write between our rollback and our cleanup: the marker stays", async () => {
    const cacheDir = freshDir();
    const dbA = await openDatabase(authDbPath(cacheDir));
    provisionAuthDb(dbA);
    const dbB = await openDatabase(authDbPath(cacheDir));
    const regB = createAuthRegistry(dbB, { configSecret: SECRET, keysDir: authKeysDir(cacheDir) });
    // B has already served a request, so it holds a cached "not initialised" reading: this is the
    // process whose first write lands inside A's rollback-to-cleanup window.
    expect(regB.health().state).toBe("uninitialised");
    const regA = createAuthRegistry(
      failingCommit(dbA, () => {
        // A has rolled back (its lock is free) and created the marker; B now commits ITS first
        // token, observing the marker as already present. A's cleanup runs next.
        regB.recordToken(tokenRec("b-first"));
      }),
      { configSecret: SECRET, keysDir: authKeysDir(cacheDir) },
    );
    expect(() => regA.recordToken(tokenRec("a-first"))).toThrow(/injected/);

    expect(markers(cacheDir)).toEqual([".tokens-initialized"]);
    expect(regB.listTokens({ includeExpired: true }).map((t) => t.jti)).toEqual(["b-first"]);
    // The committed row is protected: losing its table now fails closed.
    dbB.exec("DELETE FROM auth_tokens");
    expect(regB.health().state).toBe("lost");
    dbA.close?.();
    dbB.close?.();
  });

  it("a writer that sees the failed writer's leftover marker refuses transiently, then succeeds once it is released", async () => {
    const cacheDir = freshDir();
    const dbA = await openDatabase(authDbPath(cacheDir));
    provisionAuthDb(dbA);
    const dbB = await openDatabase(authDbPath(cacheDir));
    const regB = createAuthRegistry(dbB, { configSecret: SECRET, keysDir: authKeysDir(cacheDir) });
    let bDuringWindow: unknown;
    const regA = createAuthRegistry(
      failingCommit(dbA, () => {
        try {
          regB.recordToken(tokenRec("b-early"));
        } catch (e) {
          bDuringWindow = e;
        }
      }),
      { configSecret: SECRET, keysDir: authKeysDir(cacheDir) },
    );
    expect(() => regA.recordToken(tokenRec("a-first"))).toThrow(/injected/);
    // Marker present with no rows is indistinguishable from a real loss until A releases it, so B
    // fails closed for that instant; nothing was committed, and A's release then clears it.
    expect(String(bDuringWindow)).toMatch(/auth\.db/);
    expect(markers(cacheDir)).toEqual([]);
    regB.recordToken(tokenRec("b-retry"));
    expect(regB.listTokens({ includeExpired: true }).map((t) => t.jti)).toEqual(["b-retry"]);
    dbA.close?.();
    dbB.close?.();
  });
});
