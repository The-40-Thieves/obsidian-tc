// `<cacheDir>/oauth.db`: the bundled authorization server's own store (design v2 section 4.8), slice
// S3. Its own migration chain in WAL mode, the schema of the design, a housekeeping GC that deletes
// only what is past its time, and the lost-oauth.db row of the threat model (the part that exists
// before any route does): losing the file is fail-safe, never a refusal to start, never a marker.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { createTokenVerifier } from "../src/auth/verifier";
import { OAUTH_MIGRATION_FILES } from "../src/db/migration-manifest";
import { openConfiguredDatabase } from "../src/db/open";
import { provisionAuthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

const cfgFor = (cacheDir: string) =>
  ServerConfigSchema.parse({ vaults: [{ id: "v1", path: "/tmp/v1" }], cacheDir });
const tempCfg = () => {
  const dir = makeTempDir("oauth-db-");
  dirs.push(dir);
  return cfgFor(dir);
};
// The module under test is imported lazily so a missing module fails each test for its own reason.
const mod = () => import("../src/auth/oauth-db");

const tablesOf = (db: { prepare(sql: string): { all(): unknown[] } }): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
const columnsOf = (db: { prepare(sql: string): { all(): unknown[] } }, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

describe("oauth.db migration chain", () => {
  it("is registered as its own chain, with the 95x numbering", () => {
    expect(OAUTH_MIGRATION_FILES.length).toBeGreaterThan(0);
    expect(OAUTH_MIGRATION_FILES.every((f) => /^\d{8}_95\d_/.test(f))).toBe(true);
  });

  it("creates exactly the tables of design section 4.8 (plus the migration ledger)", async () => {
    const { provisionOauthDb } = await import("../src/db/provision");
    const db = openMemoryDb();
    provisionOauthDb(db);
    expect(tablesOf(db)).toEqual(
      [
        "auth_codes",
        "auth_requests",
        "cimd_cache",
        "grants",
        "issued_access",
        "oauth_clients",
        "refresh_tokens",
        "schema_migrations",
        "sessions",
        "setup_state",
        "users",
      ].sort(),
    );
  });

  it("carries the sketch's columns, and never a plaintext secret column", async () => {
    const { provisionOauthDb } = await import("../src/db/provision");
    const db = openMemoryDb();
    provisionOauthDb(db);
    expect(columnsOf(db, "users")).toEqual([
      "sub",
      "username",
      "password_hash",
      "scopes_allowed",
      "vaults_allowed",
      "created_at",
      "disabled_at",
    ]);
    expect(columnsOf(db, "auth_codes")).toEqual([
      "code_hash",
      "grant_id",
      "request_scope",
      "redirect_uri",
      "resource",
      "code_challenge",
      "expires_at",
      "used_at",
    ]);
    expect(columnsOf(db, "refresh_tokens")).toContain("token_hash");
    expect(columnsOf(db, "sessions")).toContain("id_hash");
    expect(columnsOf(db, "auth_requests")).toContain("handle_hash");
    const plaintext = /^(code|token|refresh_token|session_id|session|handle|secret|password)$/;
    for (const t of tablesOf(db)) {
      expect(columnsOf(db, t).filter((c) => plaintext.test(c))).toEqual([]);
    }
  });

  it("is idempotent, and re-running applies nothing", async () => {
    const { provisionOauthDb } = await import("../src/db/provision");
    const db = openMemoryDb();
    expect(provisionOauthDb(db).length).toBe(OAUTH_MIGRATION_FILES.length);
    expect(provisionOauthDb(db)).toEqual([]);
  });
});

describe("openOauthDb", () => {
  it("creates <cacheDir>/oauth.db, provisioned, in WAL mode", async () => {
    const { openOauthDb, oauthDbPath } = await mod();
    const cfg = tempCfg();
    const opened = await openOauthDb(cfg);
    try {
      expect(oauthDbPath(cfg.cacheDir)).toBe(join(cfg.cacheDir, "oauth.db"));
      expect(existsSync(join(cfg.cacheDir, "oauth.db"))).toBe(true);
      const mode = opened.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(mode.journal_mode).toBe("wal");
      expect(tablesOf(opened.db)).toContain("grants");
    } finally {
      opened.close();
    }
  });

  it("re-opens an existing file without touching its rows", async () => {
    const { openOauthDb } = await mod();
    const cfg = tempCfg();
    const first = await openOauthDb(cfg);
    first.db
      .prepare(
        "INSERT INTO users (sub, username, password_hash, created_at) VALUES ('u1', 'op', 'h', 1)",
      )
      .run();
    first.close();
    const second = await openOauthDb(cfg);
    try {
      expect(second.db.prepare("SELECT username FROM users").all()).toEqual([{ username: "op" }]);
    } finally {
      second.close();
    }
  });
});

describe("gcOauthDb: housekeeping deletes only what is past its time", () => {
  async function seeded() {
    const { provisionOauthDb } = await import("../src/db/provision");
    const db = openMemoryDb();
    provisionOauthDb(db);
    const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p);
    run("INSERT INTO users (sub, username, password_hash, created_at) VALUES ('u1','op','h',1)");
    // sessions: one expired, one live
    run("INSERT INTO sessions VALUES ('s-old','u1',1,1,?)", NOW - 1);
    run("INSERT INTO sessions VALUES ('s-live','u1',1,1,?)", NOW + 1000);
    // pending authorization requests
    for (const [h, exp] of [
      ["r-old", NOW - 1],
      ["r-live", NOW + 1000],
    ] as const) {
      run(
        "INSERT INTO auth_requests VALUES (?, 'c', 'https://c/cb', 'read:notes', 'r', 'ch', NULL, 1, ?)",
        h,
        exp,
      );
    }
    // CIMD cache
    run("INSERT INTO cimd_cache VALUES ('https://old/c', '{}', 1, ?)", NOW - 1);
    run("INSERT INTO cimd_cache VALUES ('https://live/c', '{}', 1, ?)", NOW + 1000);
    // DCR clients: unused for 91 days, used 10 days ago, never used but created 91 days ago, new
    run(
      "INSERT INTO oauth_clients VALUES ('dcr-stale','dcr','{}',?,?,NULL,NULL)",
      NOW - 200 * DAY,
      NOW - 91 * DAY,
    );
    run(
      "INSERT INTO oauth_clients VALUES ('dcr-used','dcr','{}',?,?,NULL,NULL)",
      NOW - 200 * DAY,
      NOW - 10 * DAY,
    );
    run(
      "INSERT INTO oauth_clients VALUES ('dcr-never','dcr','{}',?,NULL,NULL,NULL)",
      NOW - 91 * DAY,
    );
    run("INSERT INTO oauth_clients VALUES ('dcr-new','dcr','{}',?,NULL,NULL,NULL)", NOW - DAY);
    // grants stay (remembered consent); codes / refresh families / access jtis hang off them
    run(
      "INSERT INTO grants VALUES ('g1','u1','c','https://c/cb','read:notes','r',NULL,NULL,1,NULL)",
    );
    run(
      "INSERT INTO auth_codes VALUES ('code-old','g1','s','https://c/cb','r','ch',?,NULL)",
      NOW - 1,
    );
    run(
      "INSERT INTO auth_codes VALUES ('code-live','g1','s','https://c/cb','r','ch',?,NULL)",
      NOW + 1000,
    );
    run("INSERT INTO refresh_tokens VALUES ('rt-old','f1','g1',NULL,'s',1,NULL,?,NULL)", NOW - 1);
    run(
      "INSERT INTO refresh_tokens VALUES ('rt-live','f2','g1',NULL,'s',1,NULL,?,NULL)",
      NOW + DAY,
    );
    run("INSERT INTO issued_access VALUES ('jti-old','f1','g1',?)", NOW - 1);
    run("INSERT INTO issued_access VALUES ('jti-live','f2','g1',?)", NOW + 1000);
    return db;
  }
  const keys = (db: ReturnType<typeof openMemoryDb>, sql: string) =>
    (db.prepare(sql).all() as { k: string }[]).map((r) => r.k).sort();

  it("removes expired requests, codes, sessions, CIMD rows, stale DCR clients, past-cap families and expired jtis", async () => {
    const { gcOauthDb } = await mod();
    const db = await seeded();
    const counts = gcOauthDb(db, { now: NOW, dcrUnusedDays: 90 });
    expect(keys(db, "SELECT id_hash AS k FROM sessions")).toEqual(["s-live"]);
    expect(keys(db, "SELECT handle_hash AS k FROM auth_requests")).toEqual(["r-live"]);
    expect(keys(db, "SELECT client_id AS k FROM cimd_cache")).toEqual(["https://live/c"]);
    expect(keys(db, "SELECT client_id AS k FROM oauth_clients")).toEqual(["dcr-new", "dcr-used"]);
    expect(keys(db, "SELECT code_hash AS k FROM auth_codes")).toEqual(["code-live"]);
    expect(keys(db, "SELECT token_hash AS k FROM refresh_tokens")).toEqual(["rt-live"]);
    expect(keys(db, "SELECT jti AS k FROM issued_access")).toEqual(["jti-live"]);
    // 1 session + 1 request + 1 cimd + 2 dcr + 1 code + 1 refresh + 1 jti
    expect(counts.total).toBe(8);
  });

  it("never deletes the operator, the setup state or a grant (remembered consent survives)", async () => {
    const { gcOauthDb } = await mod();
    const db = await seeded();
    db.prepare("INSERT INTO setup_state VALUES (1, 5, 'deadbeef')").run();
    gcOauthDb(db, { now: NOW + 1000 * DAY, dcrUnusedDays: 1 });
    expect(keys(db, "SELECT sub AS k FROM users")).toEqual(["u1"]);
    expect(keys(db, "SELECT id AS k FROM grants")).toEqual(["g1"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM setup_state").get() as { n: number }).n).toBe(1);
  });

  it("is idempotent, and a second pass deletes nothing", async () => {
    const { gcOauthDb } = await mod();
    const db = await seeded();
    gcOauthDb(db, { now: NOW, dcrUnusedDays: 90 });
    expect(gcOauthDb(db, { now: NOW, dcrUnusedDays: 90 }).total).toBe(0);
  });

  it("honours dcrUnusedDays", async () => {
    const { gcOauthDb } = await mod();
    const db = await seeded();
    gcOauthDb(db, { now: NOW, dcrUnusedDays: 5 });
    // 'dcr-used' was used 10 days ago: stale at 5, so only the new one survives
    expect(keys(db, "SELECT client_id AS k FROM oauth_clients")).toEqual(["dcr-new"]);
  });
});

describe("threat row: lost oauth.db is fail-safe (the part that exists before any route)", () => {
  it("deleting oauth.db and its WAL files starts fresh and UNCLAIMED, without error or marker", async () => {
    const { openOauthDb, isClaimed, oauthDbPath } = await mod();
    const cfg = tempCfg();
    const first = await openOauthDb(cfg);
    first.db
      .prepare(
        "INSERT INTO users (sub, username, password_hash, created_at) VALUES ('u1', 'op', 'h', 1)",
      )
      .run();
    expect(isClaimed(first.db)).toBe(true);
    first.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${oauthDbPath(cfg.cacheDir)}${suffix}`, { force: true });
    }
    const again = await openOauthDb(cfg);
    try {
      expect(isClaimed(again.db)).toBe(false);
      expect(again.db.prepare("SELECT COUNT(*) AS n FROM grants").get()).toEqual({ n: 0 });
      // No lost-registry marker anywhere: nothing about oauth.db lives under auth-keys/.
      expect(existsSync(authKeysDir(cfg.cacheDir))).toBe(false);
    } finally {
      again.close();
    }
  });

  it("a disabled operator does not count as claimed", async () => {
    const { openOauthDb, isClaimed } = await mod();
    const opened = await openOauthDb(tempCfg());
    try {
      opened.db
        .prepare(
          "INSERT INTO users (sub, username, password_hash, created_at, disabled_at) VALUES ('u1', 'op', 'h', 1, 2)",
        )
        .run();
      expect(isClaimed(opened.db)).toBe(false);
    } finally {
      opened.close();
    }
  });

  it("an HS256 hand-minted token still verifies after oauth.db is lost (auth.db is separate)", async () => {
    const { openOauthDb, oauthDbPath } = await mod();
    const cfg = tempCfg();
    const authDb = openMemoryDb();
    provisionAuthDb(authDb);
    const registry = createAuthRegistry(authDb, {
      configSecret: SECRET,
      keysDir: authKeysDir(cfg.cacheDir),
    });
    const verifier = createTokenVerifier({ secret: SECRET, registry });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "ops", scope: "read:notes", iat: now, exp: now + 600 })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(SECRET));

    const opened = await openOauthDb(cfg);
    opened.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${oauthDbPath(cfg.cacheDir)}${suffix}`, { force: true });
    }
    const reopened = await openOauthDb(cfg);
    reopened.close();

    expect((await verifier.verify(token)).caller).toBe("ops");
  });
});

describe("probeOauthDb (doctor): read-only", () => {
  it("reports a missing file as absent and unclaimed, and creates nothing", async () => {
    const { probeOauthDb } = await mod();
    const cfg = tempCfg();
    const p = await probeOauthDb(cfg);
    expect(p).toMatchObject({ exists: false, claimed: false });
    expect(existsSync(p.path)).toBe(false);
  });

  it("reports claimed once an enabled operator exists", async () => {
    const { openOauthDb, probeOauthDb } = await mod();
    const cfg = tempCfg();
    const opened = await openOauthDb(cfg);
    opened.db
      .prepare(
        "INSERT INTO users (sub, username, password_hash, created_at) VALUES ('u','op','h',1)",
      )
      .run();
    opened.close();
    expect(await probeOauthDb(cfg)).toMatchObject({ exists: true, claimed: true });
  });

  it("reports a file that is not a database as unreadable, not as claimed", async () => {
    const { probeOauthDb, oauthDbPath } = await mod();
    const cfg = tempCfg();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(oauthDbPath(cfg.cacheDir), "this is not a sqlite database at all");
    const p = await probeOauthDb(cfg);
    expect(p.exists).toBe(true);
    expect(p.claimed).toBe(false);
    expect(p.unreadable).toBeDefined();
  });

  it("opens through the configured-database seam (busy timeout from config)", async () => {
    // Guard against a bare openDatabase() that would drop db.busyTimeoutMs.
    const db = await openConfiguredDatabase(tempCfg(), "oauth-seam.db");
    expect(db).toBeDefined();
    db.close?.();
  });
});
