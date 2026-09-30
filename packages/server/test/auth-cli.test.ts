// `auth rotate-key|list|revoke` and the registry writes `token mint` now makes, driven through the
// same functions cli.ts dispatches to, against a real config file and a real cache.db on disk.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRejection } from "../src/auth/jwt";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { createTokenVerifier } from "../src/auth/verifier";
import { parseCliArgs } from "../src/cli/args";
import { run_auth } from "../src/cli/commands/auth";
import { run_token_mint } from "../src/cli/commands/token-mint";
import { openDatabase } from "../src/db/open";
import { rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function deployment() {
  const root = mkdtempSync(join(tmpdir(), "auth-cli-"));
  dirs.push(root);
  const vault = join(root, "vault");
  mkdirSync(vault);
  const cacheDir = join(root, "cache");
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      vaults: [{ id: "main", path: vault }],
      cacheDir,
      auth: { mode: "jwt", jwtSecret: SECRET },
    }),
  );
  return { cacheDir, configPath };
}

let out = "";
let err = "";
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err += String(c);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const mint = async (configPath: string, sub = "agent-1") => {
  out = "";
  await run_token_mint({ kind: "token-mint", configPath, sub, json: true });
  return JSON.parse(out) as { token: string; claims: { jti: string } };
};
const auth = async (configPath: string, over: Record<string, unknown>) => {
  out = "";
  await run_auth({ kind: "auth", configPath, json: true, ...over } as never);
  return JSON.parse(out);
};

describe("auth argv", () => {
  it("parses the three subcommands", () => {
    expect(parseCliArgs(["auth", "rotate-key", "--grace", "3600", "c.json"])).toMatchObject({
      kind: "auth",
      sub: "rotate-key",
      graceSeconds: 3600,
      configPath: "c.json",
    });
    expect(parseCliArgs(["auth", "list", "--all", "--json"])).toMatchObject({
      sub: "list",
      all: true,
      json: true,
    });
    expect(
      parseCliArgs(["auth", "revoke", "abc-123", "--reason", "lost laptop", "c.json"]),
    ).toMatchObject({ sub: "revoke", jti: "abc-123", reason: "lost laptop", configPath: "c.json" });
  });

  it("rejects a missing jti, a bad grace, and an unknown subcommand", () => {
    expect(parseCliArgs(["auth", "revoke"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "rotate-key", "--grace", "-5"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "frobnicate"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth"])).toMatchObject({ kind: "error" });
  });
});

describe("token mint records every token", () => {
  it("sets jti and kid, records the row, and prints no secret", async () => {
    const d = deployment();
    const minted = await mint(d.configPath);
    expect(decodeJwt(minted.token).jti).toBe(minted.claims.jti);
    expect(decodeProtectedHeader(minted.token).kid).toBe("config");

    const rows = await auth(d.configPath, { sub: "list" });
    expect(rows).toEqual([
      expect.objectContaining({
        jti: minted.claims.jti,
        kid: "config",
        sub: "agent-1",
        state: "active",
      }),
    ]);
    expect(Object.keys(rows[0]).sort()).toEqual(["exp", "jti", "kid", "state", "sub"]);
    expect(err + out).not.toContain(SECRET);
  });
});

describe("mint -> verify -> auth revoke -> verify, through the CLI", () => {
  it("rejects the revoked token although it has not expired, and other tokens survive", async () => {
    const d = deployment();
    const a = await mint(d.configPath, "a");
    const b = await mint(d.configPath, "b");

    const db = await openDatabase(join(d.cacheDir, "auth.db"));
    const verifier = createTokenVerifier({
      secret: SECRET,
      registry: createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(d.cacheDir) }),
    });
    expect((await verifier.verify(a.token)).caller).toBe("a");

    expect(await auth(d.configPath, { sub: "revoke", jti: a.claims.jti, reason: "test" })).toEqual({
      jti: a.claims.jti,
      status: "revoked",
    });
    await expect(verifier.verify(a.token)).rejects.toMatchObject({
      constructor: AuthRejection,
      reason: "token_revoked",
    });
    expect((await verifier.verify(b.token)).caller).toBe("b");

    const states = Object.fromEntries(
      (await auth(d.configPath, { sub: "list" })).map((r: { sub: string; state: string }) => [
        r.sub,
        r.state,
      ]),
    );
    expect(states).toEqual({ a: "revoked", b: "active" });
    db.close?.();
  });

  it("revoking an unrecorded jti plants a tombstone instead of writing nothing", async () => {
    const d = deployment();
    expect(
      await auth(d.configPath, { sub: "revoke", jti: "nope", reason: "seen in a log" }),
    ).toEqual({
      jti: "nope",
      status: "tombstoned",
    });
    const rows = await auth(d.configPath, { sub: "list" });
    expect(rows).toEqual([expect.objectContaining({ jti: "nope", state: "revoked", kid: null })]);
    expect(await auth(d.configPath, { sub: "revoke", jti: "nope" })).toEqual({
      jti: "nope",
      status: "already_revoked",
    });
  });

  it("keeps the registry in auth.db and never touches cache.db", async () => {
    const d = deployment();
    await mint(d.configPath);
    expect(existsSync(join(d.cacheDir, "auth.db"))).toBe(true);
    expect(existsSync(join(d.cacheDir, "cache.db"))).toBe(false);
  });

  it("refuses every subcommand, naming the recovery, once auth.db is lost", async () => {
    const d = deployment();
    await mint(d.configPath);
    await auth(d.configPath, { sub: "rotate-key" });
    for (const f of readdirSync(d.cacheDir).filter((n) => n.startsWith("auth.db"))) {
      rmSync(join(d.cacheDir, f));
    }
    for (const over of [{ sub: "list" }, { sub: "revoke", jti: "x" }, { sub: "rotate-key" }]) {
      await expect(auth(d.configPath, over)).rejects.toThrow(/restore auth\.db from backup/);
    }
    await expect(mint(d.configPath)).rejects.toThrow(/restore auth\.db from backup/);
    expect(existsSync(join(d.cacheDir, "auth.db"))).toBe(false);
  });
});

describe("auth rotate-key through the CLI", () => {
  it("invalidates the old key's tokens (grace 0) and later mints sign with the new key", async () => {
    const d = deployment();
    const old = await mint(d.configPath);
    const r = await auth(d.configPath, { sub: "rotate-key" });
    expect(r.previous_kid).toBe("config");
    expect(readdirSync(authKeysDir(d.cacheDir)).filter((f) => f.endsWith(".key"))).toEqual([
      `${r.kid}.key`,
    ]);

    const fresh = await mint(d.configPath);
    expect(decodeProtectedHeader(fresh.token).kid).toBe(r.kid);

    const db = await openDatabase(join(d.cacheDir, "auth.db"));
    const verifier = createTokenVerifier({
      secret: SECRET,
      registry: createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(d.cacheDir) }),
    });
    await expect(verifier.verify(old.token)).rejects.toMatchObject({ reason: "key_retired" });
    expect((await verifier.verify(fresh.token)).caller).toBe("agent-1");
    db.close?.();

    const keys = await auth(d.configPath, { sub: "list", keys: true });
    expect(keys.map((k: { state: string }) => k.state)).toEqual(["retired", "active"]);
    expect(JSON.stringify(keys)).not.toContain(SECRET);
  });
});
