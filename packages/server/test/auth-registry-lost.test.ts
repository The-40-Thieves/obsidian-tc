// The auth registry (signing-key states, token revocations) lives in its OWN file, auth.db, because
// cache.db is documented as regenerable and operators are told to `rm cache.db*`. Losing the
// registry must FAIL CLOSED: once it has ever been initialised (markers and the key files sit
// OUTSIDE the database) an empty or missing auth.db is refused, never read as "never rotated, so
// the configured secret verifies everything" — that reading would un-retire keys and un-revoke
// tokens for every vault.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { AuthRejection } from "../src/auth/jwt";
import {
  authDbPath,
  authKeysDir,
  createAuthRegistry,
  registryInitialized,
  registryMarkerPath,
} from "../src/auth/registry";
import { openAuthRegistry } from "../src/auth/registry-open";
import { createTokenVerifier } from "../src/auth/verifier";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { openDatabase } from "../src/db/open";
import { provisionAuthDb, provisionCacheDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

const claims = () => {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "agent-1", scopes: ["read:notes"], iat: now, exp: now + 3600 };
};
const legacyToken = () =>
  new SignJWT(claims()).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(SECRET));

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthRejection) return e.reason;
    throw e;
  }
  return "accepted";
}

function freshDir(): string {
  const dir = makeTempDir("auth-lost-");
  dirs.push(dir);
  return dir;
}
/** A registry over a brand-new (empty, migrated) auth.db, sharing `dir`'s auth-keys directory. */
function registryOver(dir: string) {
  const db = openMemoryDb();
  provisionAuthDb(db);
  return createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(dir) });
}

describe("auth tables live in auth.db, not cache.db", () => {
  it("provisionCacheDb creates no auth_* table; provisionAuthDb creates exactly them", () => {
    const cache = openMemoryDb();
    provisionCacheDb(cache);
    const auth = openMemoryDb();
    provisionAuthDb(auth);
    const tables = (db: { prepare: (s: string) => { all: () => unknown[] } }) =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'auth_%'")
          .all() as { name: string }[]
      ).map((r) => r.name);
    expect(tables(cache)).toEqual([]);
    expect(tables(auth).sort()).toEqual(["auth_keys", "auth_tokens"]);
  });

  it("a cache.db that still carries stray auth_* tables from the pre-auth.db layout still provisions (they are ignored)", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    db.exec(
      "CREATE TABLE auth_keys (kid TEXT PRIMARY KEY); CREATE TABLE auth_tokens (jti TEXT PRIMARY KEY);",
    );
    expect(() => provisionCacheDb(db)).not.toThrow();
  });

  it("auth.db is a distinct file from cache.db", () => {
    expect(authDbPath("/x/cache")).toBe(join("/x/cache", "auth.db"));
  });
});

describe("fail closed when the registry is lost", () => {
  it("first rotation writes the keys marker; an empty replacement registry then refuses everything", async () => {
    const dir = freshDir();
    const original = registryOver(dir);
    expect(registryInitialized(authKeysDir(dir))).toBe(false);
    original.rotateKey();
    expect(existsSync(registryMarkerPath(authKeysDir(dir), "keys"))).toBe(true);

    // auth.db deleted and re-provisioned empty: same key files + markers, no rows.
    const lost = registryOver(dir);
    expect(lost.health().state).toBe("lost");
    const verifier = createTokenVerifier({ secret: SECRET, registry: lost });
    expect(await reasonOf(verifier.verify(await legacyToken()))).toBe("registry_lost");
    // Only keys were ever written: no revocation existed to lose, so a jti lookup is not refused
    // (the verifier already refused above, on the lost keys table).
    expect(lost.isRevoked("any")).toBe(false);
    expect(() => lost.signingKey()).toThrow(/auth\.db/);
    expect(() => lost.rotateKey()).toThrow(/auth\.db/);
    expect(() => lost.revoke("x", null)).toThrow(/auth\.db/);
    expect(() =>
      lost.recordToken({
        jti: "j",
        kid: "config",
        sub: null,
        scopesSummary: "",
        issuedAt: 1,
        expiresAt: 2,
      }),
    ).toThrow(/auth\.db/);
  });

  it("recording the first token (no rotation at all) arms the tokens marker", async () => {
    const dir = freshDir();
    const original = registryOver(dir);
    const minted = await signAndRecord(original, claims());
    expect(registryInitialized(authKeysDir(dir))).toBe(true);
    const lost = registryOver(dir);
    expect(lost.health().state).toBe("lost");
    // Keys were never rotated, so the configured secret still verifies signatures; what is lost is
    // the revocation list, so a token that carries a jti (all minted ones do) is refused.
    expect(
      await reasonOf(createTokenVerifier({ secret: SECRET, registry: lost }).verify(minted)),
    ).toBe("registry_lost");
  });

  it("a key file alone, without the keys marker, counts as initialised", async () => {
    const dir = freshDir();
    mkdirSync(authKeysDir(dir), { mode: 0o700 });
    writeFileSync(join(authKeysDir(dir), "k_abc.key"), "x".repeat(43), { mode: 0o600 });
    expect(registryInitialized(authKeysDir(dir))).toBe(true);
    const lost = registryOver(dir);
    expect(
      await reasonOf(
        createTokenVerifier({ secret: SECRET, registry: lost }).verify(await legacyToken()),
      ),
    ).toBe("registry_lost");
  });

  it("a deployment that never initialised the registry keeps the legacy jwtSecret path", async () => {
    const dir = freshDir();
    const reg = registryOver(dir);
    expect(reg.health().state).toBe("uninitialised");
    expect(
      await reasonOf(
        createTokenVerifier({ secret: SECRET, registry: reg }).verify(await legacyToken()),
      ),
    ).toBe("accepted");
  });

  it("tokens recorded but never rotated is a healthy registry (config kid), not lost", async () => {
    const dir = freshDir();
    const reg = registryOver(dir);
    const token = await signAndRecord(reg, claims());
    expect(reg.health().state).toBe("ok");
    expect(
      await reasonOf(createTokenVerifier({ secret: SECRET, registry: reg }).verify(token)),
    ).toBe("accepted");
  });

  it("a failed first write does not leave a marker that would lock the deployment out", () => {
    const dir = freshDir();
    const db = openMemoryDb();
    provisionAuthDb(db);
    db.exec("DROP TABLE auth_tokens");
    const reg = createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(dir) });
    expect(() =>
      reg.recordToken({
        jti: "j",
        kid: "config",
        sub: null,
        scopesSummary: "",
        issuedAt: 1,
        expiresAt: 2,
      }),
    ).toThrow();
    expect(registryInitialized(authKeysDir(dir))).toBe(false);
  });
});

describe("openAuthRegistry (what serve and the CLI call)", () => {
  const cfgFor = (cacheDir: string) => ({
    cacheDir,
    db: { busyTimeoutMs: 5000 },
    auth: { mode: "jwt" as const, jwtSecret: SECRET },
  });

  it("never initialised: creates auth.db and verifies with the configured secret", async () => {
    const cacheDir = freshDir();
    const { registry, close } = await openAuthRegistry(cfgFor(cacheDir) as never);
    try {
      expect(existsSync(authDbPath(cacheDir))).toBe(true);
      expect(registry.health().state).toBe("uninitialised");
    } finally {
      close();
    }
  });

  it("markers present but auth.db MISSING: lost, and auth.db is NOT re-created", async () => {
    const cacheDir = freshDir();
    const first = await openAuthRegistry(cfgFor(cacheDir) as never);
    first.registry.rotateKey();
    first.close();
    for (const f of readdirSync(cacheDir).filter((n) => n.startsWith("auth.db"))) {
      rmSync(join(cacheDir, f));
    }

    const second = await openAuthRegistry(cfgFor(cacheDir) as never);
    try {
      expect(second.registry.health().state).toBe("lost");
      expect(existsSync(authDbPath(cacheDir))).toBe(false);
      const v = createTokenVerifier({ secret: SECRET, registry: second.registry });
      expect(await reasonOf(v.verify(await legacyToken()))).toBe("registry_lost");
    } finally {
      second.close();
    }
  });

  it("auth.db present and populated: healthy across a reopen", async () => {
    const cacheDir = freshDir();
    const first = await openAuthRegistry(cfgFor(cacheDir) as never);
    first.registry.rotateKey();
    first.close();
    const second = await openAuthRegistry(cfgFor(cacheDir) as never);
    try {
      expect(second.registry.health().state).toBe("ok");
    } finally {
      second.close();
    }
  });
});

describe("no cache wipe touches auth.db", () => {
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

  it("`rm <cacheDir>/cache.db*` (the documented recovery) does not match auth.db or auth-keys/", () => {
    const cacheDir = freshDir();
    for (const f of ["cache.db", "cache.db-wal", "cache.db-shm", "auth.db", "auth.db-wal"]) {
      writeFileSync(join(cacheDir, f), f);
    }
    mkdirSync(authKeysDir(cacheDir));
    const glob = readdirSync(cacheDir).filter((f) => /^cache\.db/.test(f));
    expect(glob.sort()).toEqual(["cache.db", "cache.db-shm", "cache.db-wal"]);
  });

  it("compact leaves auth.db byte-identical and cache.db carries no auth tables", {
    timeout: stallTimeout(30_000),
  }, async () => {
    const vault = freshDir();
    const cacheDir = freshDir();
    const confDir = freshDir();
    writeFileSync(join(vault, "a.md"), "hello");
    const configPath = join(confDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vault }] }));
    const cache = await openDatabase(join(cacheDir, "cache.db"));
    provisionCacheDb(cache, { version: "test" });
    cache.close?.();
    const authDb = await openDatabase(authDbPath(cacheDir));
    provisionAuthDb(authDb, { version: "test" });
    const reg = createAuthRegistry(authDb, {
      configSecret: SECRET,
      keysDir: authKeysDir(cacheDir),
    });
    reg.revoke("some-external-jti", "compromised");
    authDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    authDb.close?.();
    const before = sha(authDbPath(cacheDir));

    const r = spawnSync("bun", [CLI, "compact", "--config", configPath], {
      encoding: "utf8",
      timeout: stallTimeout(20_000),
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(r.status, `compact stderr: ${r.stderr}`).toBe(0);
    expect(sha(authDbPath(cacheDir))).toBe(before);

    const after = await openDatabase(join(cacheDir, "cache.db"));
    const names = (
      after.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'auth_%'").all() as unknown[]
    ).length;
    after.close?.();
    expect(names).toBe(0);
  });

  it("reset_vault_cache, the maintenance sweep and compact never name an auth table or auth.db", () => {
    const src = (rel: string) =>
      readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
    for (const rel of [
      "tools/m1/registry-tools.ts",
      "db/maintenance.ts",
      "cli/commands/compact.ts",
      "workspace/rerun.ts",
    ]) {
      const text = src(rel);
      expect(text.length, `${rel} must be a real file`).toBeGreaterThan(1000);
      expect(text, rel).not.toMatch(/auth_keys|auth_tokens|auth\.db/);
    }
  });
});
