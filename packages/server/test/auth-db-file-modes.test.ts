// auth.db and oauth.db hold revocations, grants and (in later slices) refresh-token hashes and
// operator credentials. Created under the usual 022 umask they were 0644, as were the -wal/-shm
// files beside them. They are owner-only (0600), however they come into existence and whatever
// state a previous version left them in.
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOauthDb } from "../src/auth/oauth-db";
import { openAuthRegistry } from "../src/auth/registry-open";
import { openConfiguredDatabase } from "../src/db/open";
import { makeTempDir, rmTemp } from "./tmp";

const posix = process.platform === "win32" ? describe.skip : describe;
const modeOf = (p: string) => statSync(p).mode & 0o777;
const dirs: string[] = [];
let priorUmask = 0;
beforeEach(() => {
  priorUmask = process.umask(0o022);
});
afterEach(() => {
  process.umask(priorUmask);
  for (const d of dirs.splice(0)) rmTemp(d);
});

function configIn() {
  const root = makeTempDir("db-modes-");
  dirs.push(root);
  mkdirSync(join(root, "cache"), { recursive: true });
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: join(root, "cache"),
    auth: { mode: "jwt", jwtSecret: "test-only-secret-not-a-real-credential-0123456789" },
  });
}

function expectOwnerOnly(base: string) {
  const present = ["", "-wal", "-shm"].map((e) => `${base}${e}`).filter((p) => existsSync(p));
  // Floor: the main file and at least one WAL sidecar must exist, or this proves nothing.
  expect(present.length).toBeGreaterThanOrEqual(2);
  for (const p of present) expect(modeOf(p).toString(8), p).toBe("600");
}

posix("auth.db and oauth.db are owner-only under umask 022", () => {
  it("oauth.db, -wal and -shm are 0600 while open and written to", async () => {
    const config = configIn();
    const { db, close } = await openOauthDb(config);
    try {
      db.prepare("SELECT count(*) FROM users").get();
      expectOwnerOnly(join(config.cacheDir, "oauth.db"));
    } finally {
      close();
    }
  });

  it("auth.db, -wal and -shm are 0600 while open and written to", async () => {
    const config = configIn();
    const opened = await openAuthRegistry(config);
    try {
      opened.registry.rotateKey({ graceSeconds: 0 });
      expectOwnerOnly(join(config.cacheDir, "auth.db"));
    } finally {
      opened.close();
    }
  });

  it("a database a previous version left 0644 (with sidecars) is tightened on the next open", async () => {
    const config = configIn();
    const first = await openOauthDb(config);
    const path = join(config.cacheDir, "oauth.db");
    first.db.prepare("SELECT count(*) FROM users").get();
    for (const e of ["", "-wal", "-shm"]) if (existsSync(path + e)) chmodSync(path + e, 0o644);
    first.close();
    chmodSync(path, 0o644);
    const second = await openOauthDb(config);
    try {
      second.db.prepare("SELECT count(*) FROM users").get();
      expectOwnerOnly(path);
    } finally {
      second.close();
    }
  });

  it("an existing empty or foreign file is not clobbered, only tightened", async () => {
    const config = configIn();
    writeFileSync(join(config.cacheDir, "oauth.db"), "");
    const { db, close } = await openOauthDb(config);
    try {
      db.prepare("SELECT count(*) FROM users").get();
      expect(modeOf(join(config.cacheDir, "oauth.db")).toString(8)).toBe("600");
    } finally {
      close();
    }
  });

  it("a pre-existing 0644 auth.db (with sidecars) is tightened on the next open", async () => {
    const config = configIn();
    const path = join(config.cacheDir, "auth.db");
    const first = await openAuthRegistry(config);
    try {
      first.registry.rotateKey({ graceSeconds: 0 });
      for (const e of ["", "-wal", "-shm"]) if (existsSync(path + e)) chmodSync(path + e, 0o644);
    } finally {
      first.close();
    }
    const second = await openAuthRegistry(config);
    try {
      second.registry.listKeys();
      expectOwnerOnly(path);
    } finally {
      second.close();
    }
  });

  it("sidecars born under a permissive umask are owner-only too: SQLite gives them the main file's mode", async () => {
    process.umask(0o000);
    const config = configIn();
    const { db, close } = await openOauthDb(config);
    try {
      db.prepare("SELECT count(*) FROM users").get();
      expectOwnerOnly(join(config.cacheDir, "oauth.db"));
    } finally {
      close();
    }
  });

  it("tightening a looser database writes one notice naming it; a later open is silent", async () => {
    const config = configIn();
    const path = join(config.cacheDir, "oauth.db");
    (await openOauthDb(config)).close();
    chmodSync(path, 0o644);
    const notices = () =>
      vi
        .mocked(process.stderr.write)
        .mock.calls.map(([s]) => String(s))
        .filter((s) => s.includes("oauth.db") && s.includes("0600"));
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      (await openOauthDb(config)).close();
      expect(modeOf(path)).toBe(0o600);
      expect(notices()).toHaveLength(1);
      (await openOauthDb(config)).close();
      expect(notices()).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });
});

posix("openConfiguredDatabase tightens a 0644 file on the file itself", () => {
  it("opening a 0644 oauth.db with ownerOnly leaves that file 0600 on disk", async () => {
    const config = configIn();
    const path = join(config.cacheDir, "oauth.db");
    (await openOauthDb(config)).close();
    chmodSync(path, 0o644);
    const db = await openConfiguredDatabase(config, "oauth.db", { ownerOnly: true });
    try {
      expect(modeOf(path)).toBe(0o600);
    } finally {
      db.close?.();
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "no chmod where the platform has no POSIX modes",
  () => {
    it("a looser database keeps its mode when the platform reports win32", async () => {
      const config = configIn();
      const path = join(config.cacheDir, "oauth.db");
      (await openOauthDb(config)).close();
      chmodSync(path, 0o644);
      const real = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        (await openOauthDb(config)).close();
      } finally {
        if (real) Object.defineProperty(process, "platform", real);
      }
      expect(modeOf(path)).toBe(0o644);
    });
  },
);
