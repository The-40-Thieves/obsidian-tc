// A corrupt auth.db was reported healthy by `doctor`: probeAuthRegistry swallowed every database
// error as "uninitialised", and auth.registry then said OK whenever a static key was configured,
// while `serve` aborted with "file is not a database". The reviewer's repro: write non-SQLite
// bytes to <cacheDir>/auth.db with JWT mode and auth.jwtSecret.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { authDbPath } from "../src/auth/registry";
import { openAuthRegistry, probeAuthRegistry } from "../src/auth/registry-open";
import { openDatabase } from "../src/db/open";
import { authRegistryCheck } from "../src/doctor/auth-registry";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});
const freshDir = (): string => {
  const dir = makeTempDir("auth-corrupt-");
  dirs.push(dir);
  return dir;
};
const cfgFor = (cacheDir: string) =>
  ({
    cacheDir,
    db: { busyTimeoutMs: 5000 },
    auth: { mode: "jwt" as const, jwtSecret: "test-only-secret-not-a-real-credential-0123456789" },
  }) as never;
const ctx = { serverVersion: "t" };

/** What the CLI hands the check, from a probe. */
const viewOf = (probe: Awaited<ReturnType<typeof probeAuthRegistry>>) => ({
  authMode: "jwt" as const,
  state: probe.health.state,
  dbPath: probe.dbPath,
  keysDir: probe.keysDir,
  keyFileIssues: probe.keyFileIssues,
  requireJti: true,
  platform: "linux" as const,
  jwtSecretConfigured: true,
  jwksConfigured: false,
  ...(probe.unreadable !== undefined ? { unreadable: probe.unreadable } : {}),
});

describe("doctor: a corrupt auth.db", () => {
  it("is reported by the probe and FAILS the check, with a static key configured (the repro)", async () => {
    const cacheDir = freshDir();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(authDbPath(cacheDir), Buffer.from("this is definitely not a sqlite file ".repeat(200)));
    const probe = await probeAuthRegistry(cfgFor(cacheDir));
    expect(probe.unreadable).toMatch(/not a database|malformed|corrupt/i);
    const r = await authRegistryCheck(viewOf(probe)).run(ctx);
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/auth\.db/);
    expect(r.summary).toMatch(/unreadable|corrupt|not a database/i);
    expect(r.remediation).toMatch(/restore auth\.db from backup/i);
  });

  it("and serve really does abort on it (doctor and serve agree)", async () => {
    const cacheDir = freshDir();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(authDbPath(cacheDir), Buffer.from("garbage ".repeat(500)));
    await expect(openAuthRegistry(cfgFor(cacheDir))).rejects.toThrow(/not a database|malformed/i);
  });

  it("FAILS in oidc mode too (the registry still answers revocation)", async () => {
    const cacheDir = freshDir();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(authDbPath(cacheDir), Buffer.from("garbage ".repeat(500)));
    const probe = await probeAuthRegistry(cfgFor(cacheDir));
    const r = await authRegistryCheck({ ...viewOf(probe), authMode: "oidc" }).run(ctx);
    expect(r.status).toBe("fail");
  });

  it("stays quiet when auth.mode is none", async () => {
    const cacheDir = freshDir();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(authDbPath(cacheDir), Buffer.from("garbage ".repeat(500)));
    const probe = await probeAuthRegistry(cfgFor(cacheDir));
    const r = await authRegistryCheck({ ...viewOf(probe), authMode: "none" }).run(ctx);
    expect(r.status).toBe("ok");
  });

  it("an auth.db that is a valid but unmigrated database is NOT corrupt (unchanged reading)", async () => {
    const cacheDir = freshDir();
    mkdirSync(cacheDir, { recursive: true });
    const db = await openDatabase(authDbPath(cacheDir));
    db.exec("CREATE TABLE unrelated (x INTEGER)");
    db.close?.();
    const probe = await probeAuthRegistry(cfgFor(cacheDir));
    expect(probe.unreadable).toBeUndefined();
    expect(probe.health.state).toBe("uninitialised");
    expect((await authRegistryCheck(viewOf(probe)).run(ctx)).status).toBe("ok");
  });

  it("no auth.db at all is not corrupt", async () => {
    const probe = await probeAuthRegistry(cfgFor(join(freshDir(), "never-created")));
    expect(probe.unreadable).toBeUndefined();
  });
});
