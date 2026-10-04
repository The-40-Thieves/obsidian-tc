// `obsidian-tc auth as set-password` (design v2 section 4.5), slice S4: the CLI way to claim the
// bundled authorization server, driven through the same function cli.ts dispatches to, against a
// real config file and a real oauth.db on disk.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../src/auth/as-password";
import { openOauthDb } from "../src/auth/oauth-db";
import { parseCliArgs } from "../src/cli/args";
import { CliError } from "../src/cli/cli-error";
import { run_auth } from "../src/cli/commands/auth";
import { promptHidden } from "../src/cli/commands/auth-as";
import { makeTempDir, rmTemp } from "./tmp";

const PW = "correct horse battery staple";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function deployment(as: Record<string, unknown> | false = {}) {
  const root = makeTempDir("as-set-password-");
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
      auth: {
        mode: "jwt",
        jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
        resource: "https://vault.example.com/mcp",
        ...(as === false
          ? {}
          : { as: { enabled: true, issuer: "https://vault.example.com", ...as } }),
      },
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

const setPassword = (
  configPath: string,
  over: Record<string, unknown> = {},
  io: Parameters<typeof run_auth>[1] = {},
) =>
  run_auth({ kind: "auth", sub: "as-set-password", configPath, stdin: true, ...over } as never, {
    readStdin: async () => `${PW}\n`,
    ...io,
  });

const dbOf = async (cacheDir: string) =>
  openOauthDb(ServerConfigSchema.parse({ vaults: [{ id: "main", path: "/tmp/v" }], cacheDir }));

describe("argv", () => {
  it("parses `auth as set-password [--user <name>] [--stdin] [path]`", () => {
    expect(
      parseCliArgs(["auth", "as", "set-password", "--user", "bob", "--stdin", "c.json"]),
    ).toMatchObject({
      kind: "auth",
      sub: "as-set-password",
      user: "bob",
      stdin: true,
      configPath: "c.json",
    });
    expect(parseCliArgs(["auth", "as", "set-password"])).toMatchObject({
      kind: "auth",
      sub: "as-set-password",
      stdin: false,
    });
  });

  it("refuses an unknown or missing `as` subcommand, and flags that belong to another subcommand", () => {
    expect(parseCliArgs(["auth", "as", "nope"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "as"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "list", "--stdin"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "list", "--user", "bob"])).toMatchObject({ kind: "error" });
  });
});

describe("claiming from the CLI", () => {
  it("creates the operator from stdin: an Argon2id hash, the claim recorded, the password never printed", async () => {
    const { configPath, cacheDir } = deployment();
    await setPassword(configPath);
    const store = await dbOf(cacheDir);
    try {
      const users = store.db.prepare("SELECT * FROM users").all() as Array<{
        sub: string;
        username: string;
        password_hash: string;
      }>;
      expect(users).toHaveLength(1);
      expect(users[0]?.username).toBe("operator");
      expect(users[0]?.sub).toMatch(/^usr_/);
      expect(users[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(await verifyPassword(PW, users[0]?.password_hash ?? "")).toBe(true);
      const state = store.db.prepare("SELECT * FROM setup_state").get() as {
        claimed_at: number;
        setup_token_hash_used: string | null;
      };
      expect(state.claimed_at).toBeGreaterThan(0);
      expect(state.setup_token_hash_used).toBeNull();
    } finally {
      store.close();
    }
    expect(out + err).toMatch(/operator/);
    expect(out + err).not.toContain(PW);
  });

  it("strips exactly one trailing newline (LF or CRLF) and keeps other whitespace", async () => {
    for (const [given, expected] of [
      [`${PW}\r\n`, PW],
      [`${PW}\n`, PW],
      [` ${PW} \n`, ` ${PW} `],
    ] as const) {
      const { configPath, cacheDir } = deployment();
      await setPassword(configPath, {}, { readStdin: async () => given });
      const store = await dbOf(cacheDir);
      try {
        const hash = (
          store.db.prepare("SELECT password_hash FROM users").get() as { password_hash: string }
        ).password_hash;
        expect(await verifyPassword(expected, hash)).toBe(true);
      } finally {
        store.close();
      }
    }
  });

  it("honours --user, and --json prints no secret", async () => {
    const { configPath, cacheDir } = deployment();
    await setPassword(configPath, { user: "Alice", json: true });
    expect(JSON.parse(out)).toMatchObject({ user: "alice", status: "claimed" });
    expect(out).not.toContain(PW);
    const store = await dbOf(cacheDir);
    try {
      expect(
        (store.db.prepare("SELECT username FROM users").get() as { username: string }).username,
      ).toBe("alice");
    } finally {
      store.close();
    }
  });

  it("changes the password of the existing operator and ends their sessions", async () => {
    const { configPath, cacheDir } = deployment();
    await setPassword(configPath);
    const store = await dbOf(cacheDir);
    try {
      const sub = (store.db.prepare("SELECT sub FROM users").get() as { sub: string }).sub;
      store.db
        .prepare(
          "INSERT INTO sessions (id_hash, sub, created_at, last_seen_at, expires_at) VALUES ('h', ?, 1, 1, 9e15)",
        )
        .run(sub);
      const next = "another long passphrase 2";
      await setPassword(configPath, {}, { readStdin: async () => `${next}\n` });
      const hash = (
        store.db.prepare("SELECT password_hash FROM users").get() as { password_hash: string }
      ).password_hash;
      expect(await verifyPassword(next, hash)).toBe(true);
      expect(await verifyPassword(PW, hash)).toBe(false);
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    } finally {
      store.close();
    }
    expect(out).toMatch(/updated/i);
  });

  it("refuses to add a second operator (a later slice) and says which one exists", async () => {
    const { configPath } = deployment();
    await setPassword(configPath);
    await expect(setPassword(configPath, { user: "mallory" })).rejects.toThrow(
      /operator.*already|already.*operator/i,
    );
  });

  it("refuses a password under 12 characters and leaves the server unclaimed", async () => {
    const { configPath, cacheDir } = deployment();
    await expect(setPassword(configPath, {}, { readStdin: async () => "short\n" })).rejects.toThrow(
      /12/,
    );
    expect(existsSync(join(cacheDir, "oauth.db"))).toBe(false);
  });

  it("refuses when auth.as is not enabled in the config", async () => {
    const { configPath } = deployment(false);
    await expect(setPassword(configPath)).rejects.toThrow(/auth\.as/);
  });

  it("refuses on a Node without crypto.argon2, naming Node 24.7", async () => {
    const { configPath } = deployment();
    await expect(
      setPassword(configPath, {}, { runtime: { version: "24.6.0", hasArgon2: false } }),
    ).rejects.toThrow(/24\.7/);
  });

  it("without --stdin and without a terminal, refuses and points at --stdin", async () => {
    const { configPath } = deployment();
    const run = run_auth(
      { kind: "auth", sub: "as-set-password", configPath, stdin: false } as never,
      { isTTY: false },
    );
    await expect(run).rejects.toThrow(CliError);
    await expect(run).rejects.toThrow(/--stdin/);
  });

  it("on a terminal asks twice and refuses a mismatch", async () => {
    const { configPath } = deployment();
    const answers = [PW, `${PW}x`];
    const asked: string[] = [];
    const run = run_auth(
      { kind: "auth", sub: "as-set-password", configPath, stdin: false } as never,
      {
        isTTY: true,
        prompt: async (label: string) => {
          asked.push(label);
          return answers.shift() ?? "";
        },
      },
    );
    await expect(run).rejects.toThrow(/do not match/i);
    expect(asked).toHaveLength(2);
  });

  it("on a terminal claims when both answers agree", async () => {
    const { configPath, cacheDir } = deployment();
    await run_auth({ kind: "auth", sub: "as-set-password", configPath, stdin: false } as never, {
      isTTY: true,
      prompt: async () => PW,
    });
    const store = await dbOf(cacheDir);
    try {
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    } finally {
      store.close();
    }
  });
});

describe("the hidden prompt on a real terminal", () => {
  /** A stand-in for process.stdin in raw mode: records the mode changes, feeds keystrokes. */
  function fakeTerminal() {
    const input = new EventEmitter() as EventEmitter & {
      setRawMode: (on: boolean) => void;
      setEncoding: (e: string) => void;
      resume: () => void;
      pause: () => void;
    };
    const raw: boolean[] = [];
    let paused = false;
    input.setRawMode = (on) => void raw.push(on);
    input.setEncoding = () => {};
    input.resume = () => {
      paused = false;
    };
    input.pause = () => {
      paused = true;
    };
    const written: string[] = [];
    return {
      term: { stdin: input as never, write: (t: string) => void written.push(t) },
      type: (keys: string) => input.emit("data", keys),
      raw,
      written,
      paused: () => paused,
      listeners: () => input.listenerCount("data"),
    };
  }

  it("echoes nothing, honours backspace, and restores the terminal on Enter", async () => {
    const t = fakeTerminal();
    const answer = promptHidden("Password: ", t.term);
    expect(t.raw).toEqual([true]);
    t.type("hunter2");
    t.type("x\u007f\r");
    await expect(answer).resolves.toBe("hunter2");
    expect(t.raw).toEqual([true, false]);
    expect(t.paused()).toBe(true);
    expect(t.listeners()).toBe(0);
    // The label and the closing newline only: no typed character is ever written back.
    expect(t.written).toEqual(["Password: ", "\n"]);
  });

  it("aborts on Ctrl-C, and still restores the terminal", async () => {
    const t = fakeTerminal();
    const answer = promptHidden("Password: ", t.term);
    t.type("abc\u0003");
    await expect(answer).rejects.toThrow(CliError);
    expect(t.raw).toEqual([true, false]);
    expect(t.listeners()).toBe(0);
  });

  it("takes a pasted line in one chunk and stops at the first line break", async () => {
    const t = fakeTerminal();
    const answer = promptHidden("Password: ", t.term);
    t.type("pasted value\nrest");
    await expect(answer).resolves.toBe("pasted value");
  });
});
