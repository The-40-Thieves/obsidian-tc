// auth.db and oauth.db hold revocations, grants and (in later slices) refresh-token hashes and
// operator credentials. Created under the usual 022 umask they were 0644, as were the -wal/-shm
// files beside them. They are owner-only (0600), however they come into existence and whatever
// state a previous version left them in.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  linkSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOauthDb } from "../src/auth/oauth-db";
import { openAuthRegistry } from "../src/auth/registry-open";
import { openConfiguredDatabase } from "../src/db/open";
import { makeTempDir, rmTemp } from "./tmp";

// The chmod-failure tests make fchmodSync/chmodSync throw; every other call passes straight through.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync), fchmodSync: vi.fn(actual.fchmodSync) };
});

const win32 = process.platform === "win32";
const posix = win32 ? describe.skip : describe;
const modeOf = (p: string) => statSync(p).mode & 0o777;
const dirs: string[] = [];
let priorUmask = 0;
beforeEach(() => {
  priorUmask = process.umask(0o022);
});
afterEach(() => {
  vi.mocked(fchmodSync).mockRestore();
  vi.mocked(chmodSync).mockRestore();
  process.umask(priorUmask);
  for (const d of dirs.splice(0)) rmTemp(d);
});

function configIn(cacheName = "cache") {
  const root = makeTempDir("db-modes-");
  dirs.push(root);
  mkdirSync(join(root, cacheName), { recursive: true });
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: join(root, cacheName),
    auth: { mode: "jwt", jwtSecret: "test-only-secret-not-a-real-credential-0123456789" },
  });
}

/** Every stderr write made while `body` runs, as the strings written. */
async function captureStderr(body: () => Promise<unknown>): Promise<string[]> {
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await body();
    return log.mock.calls.map(([s]) => String(s));
  } finally {
    log.mockRestore();
  }
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

  it("stale -wal and -shm left looser by an earlier run are tightened before the open", async () => {
    const config = configIn();
    const path = join(config.cacheDir, "oauth.db");
    const aside = (e: string) => join(dirname(config.cacheDir), `aside${e}`);
    const first = await openOauthDb(config);
    // A write while the connection is open keeps the WAL non-empty when it is copied aside.
    first.db.prepare("CREATE TABLE IF NOT EXISTS stale_probe (x INTEGER)").run();
    for (const e of ["-wal", "-shm"]) copyFileSync(path + e, aside(e));
    // Closing checkpoints and deletes -wal/-shm, so the copies come back as stale leftovers.
    first.close();
    for (const e of ["-wal", "-shm"]) {
      copyFileSync(aside(e), path + e);
      chmodSync(path + e, 0o644);
    }
    expect(existsSync(`${path}-wal`) && existsSync(`${path}-shm`)).toBe(true);
    const db = await openConfiguredDatabase(config, "oauth.db", { ownerOnly: true });
    try {
      expectOwnerOnly(path);
    } finally {
      db.close?.();
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
    const notices = (lines: string[]) =>
      lines.filter((s) => s.includes("oauth.db") && s.includes("0600"));
    const first = await captureStderr(async () => (await openOauthDb(config)).close());
    expect(modeOf(path)).toBe(0o600);
    expect(notices(first)).toHaveLength(1);
    const second = await captureStderr(async () => (await openOauthDb(config)).close());
    expect(notices(second)).toHaveLength(0);
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

describe("tightening never follows a link or touches a file it does not own", () => {
  it.skipIf(win32)(
    "a symlinked oauth.db is refused: its target keeps its mode and the notice says a link was refused",
    async () => {
      const config = configIn();
      const path = join(config.cacheDir, "oauth.db");
      const target = join(dirname(config.cacheDir), "elsewhere.db");
      writeFileSync(target, "");
      chmodSync(target, 0o644);
      symlinkSync(target, path);
      const lines = await captureStderr(async () =>
        (await openConfiguredDatabase(config, "oauth.db", { ownerOnly: true })).close?.(),
      );
      expect(modeOf(target)).toBe(0o644);
      const notice = lines.filter((s) => s.includes("[db]"));
      expect(notice).toHaveLength(1);
      expect(notice[0]).toMatch(/refused.*symbolic link/);
    },
  );

  it.skipIf(win32)(
    "a hard-linked oauth.db (nlink 2) is not chmodded: the other name keeps its mode",
    async () => {
      const config = configIn();
      const path = join(config.cacheDir, "oauth.db");
      (await openOauthDb(config)).close();
      chmodSync(path, 0o644);
      const other = join(dirname(config.cacheDir), "other-name.db");
      linkSync(path, other);
      const lines = await captureStderr(async () =>
        (await openConfiguredDatabase(config, "oauth.db", { ownerOnly: true })).close?.(),
      );
      expect(modeOf(other)).toBe(0o644);
      expect(lines.filter((s) => s.includes("[db]")).join("")).toMatch(/refused.*hard link/);
    },
  );

  it.skipIf(win32)(
    "a file swapped in after the pre-open check is tightened to 0600 by the post-open check",
    async () => {
      const config = configIn();
      const path = join(config.cacheDir, "oauth.db");
      (await openOauthDb(config)).close();
      const afterPreCheck = vi.fn(() => {
        rmSync(path);
        writeFileSync(path, "");
        chmodSync(path, 0o644);
      });
      const db = await openConfiguredDatabase(
        config,
        "oauth.db",
        { ownerOnly: true },
        { afterPreCheck },
      );
      try {
        expect(afterPreCheck).toHaveBeenCalledTimes(1);
        expect(modeOf(path)).toBe(0o600);
      } finally {
        db.close?.();
      }
    },
  );
});

describe("a chmod failure does not abort the open", () => {
  it.skipIf(win32)(
    "one notice names the basename and EPERM, and the database still opens",
    async () => {
      const config = configIn();
      const path = join(config.cacheDir, "oauth.db");
      (await openOauthDb(config)).close();
      chmodSync(path, 0o644);
      const eperm = () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      };
      vi.mocked(fchmodSync).mockImplementation(eperm);
      vi.mocked(chmodSync).mockImplementation(eperm);
      let opened = false;
      const lines = await captureStderr(async () => {
        const db = await openConfiguredDatabase(config, "oauth.db", { ownerOnly: true });
        opened = true;
        db.close?.();
      });
      expect(opened).toBe(true);
      const notice = lines.filter((s) => s.includes("[db]"));
      expect(notice).toHaveLength(1);
      expect(notice[0]).toMatch(/oauth\.db.*EPERM/);
    },
  );

  it.skipIf(win32)(
    "a sidecar that cannot be tightened still sends the notice for the others",
    async () => {
      const config = configIn();
      const path = join(config.cacheDir, "oauth.db");
      (await openOauthDb(config)).close();
      chmodSync(path, 0o644);
      writeFileSync(`${path}-wal`, "");
      chmodSync(`${path}-wal`, 0o644);
      // Pre-open order is main, then -wal: fail the second descriptor-level chmod only.
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      let call = 0;
      vi.mocked(fchmodSync).mockImplementation((fd, mode) => {
        call += 1;
        if (call === 2) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return real.fchmodSync(fd, mode);
      });
      const lines = await captureStderr(async () => {
        (await openConfiguredDatabase(config, "oauth.db", { ownerOnly: true })).close?.();
      });
      const notice = lines.filter((s) => s.includes("[db]"));
      expect(notice).toHaveLength(1);
      expect(notice[0]).toMatch(/oauth\.db-wal.*EPERM/);
      expect(notice[0]).toMatch(/oauth\.db tightened to 0600/);
      expect(modeOf(path)).toBe(0o600);
    },
  );
});

describe("the notice logs basenames only, as one line", () => {
  it("a cacheDir containing a newline produces a single-line notice with no directory", async () => {
    const config = configIn("cache\nforged: log line");
    const path = join(config.cacheDir, "oauth.db");
    (await openOauthDb(config)).close();
    chmodSync(path, 0o644);
    const lines = await captureStderr(async () =>
      (await openConfiguredDatabase(config, "oauth.db", { ownerOnly: true })).close?.(),
    );
    const notice = lines.filter((s) => s.includes("[db]"));
    expect(notice).toHaveLength(1);
    const line = notice[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(line).not.toContain("forged");
    expect(line).not.toContain(dirname(config.cacheDir));
    expect(line).toMatch(/oauth\.db/);
  });
});

it.skipIf(win32)("a looser database keeps its mode when the platform reports win32", async () => {
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
