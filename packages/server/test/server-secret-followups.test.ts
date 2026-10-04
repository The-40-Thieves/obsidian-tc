// Residuals from the server-local secret review: concurrent repair of a corrupt key, the refusal
// message for an exposed key, and the HITL boot line.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverSecret } from "../src/auth/server-secret";
import { bootHitl, hsConfig } from "./hitl-wire-helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const tmp = (): string => {
  const d = makeTempDir("obtc-secret-fu-");
  dirs.push(d);
  return d;
};
// Spawning is the slow part on Windows, and the property (every racer returns the one final key)
// holds with fewer processes, so Windows races 6.
const RACERS = process.platform === "win32" ? 6 : 24;
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // Nothing may still hold the directory when it is removed: kill stragglers and wait for each exit.
  const live = children.splice(0).filter((p) => p.exitCode === null && p.signalCode === null);
  await Promise.all(
    live.map(
      (p) =>
        new Promise<void>((resolve) => {
          p.once("close", () => resolve());
          p.kill("SIGKILL");
        }),
    ),
  );
  for (const d of dirs.splice(0)) rmTemp(d);
});

const secretFile = (dir: string): string => join(dir, "server-secrets", "wiki-generated.key");

const corruptSecret = (dir: string): void => {
  mkdirSync(join(dir, "server-secrets"), { mode: 0o700 });
  writeFileSync(secretFile(dir), "truncated", { mode: 0o600 });
  chmodSync(secretFile(dir), 0o600);
};

interface Racer {
  ready: Promise<void>;
  done: Promise<{ code: number | null; out: string }>;
}

/** A child that prints `ready`, waits for `goFile`, then prints the key `serverSecret` returned. */
function racer(dir: string, goFile: string): Racer {
  const p = spawn("bun", [join(here, "server-secret-child.ts"), dir, goFile], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(p);
  let out = "";
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  p.stdout.on("data", (b) => {
    out += b;
    if (out.includes("ready\n")) markReady();
  });
  const done = new Promise<{ code: number | null; out: string }>((resolve) => {
    p.on("close", (code) => {
      markReady();
      resolve({ code, out: out.replace(/^ready\n/, "") });
    });
  });
  return { ready, done };
}

describe("concurrent repair of a corrupt server secret", () => {
  it(
    "every process returns the same key, and it is the one left in the file",
    async () => {
      const dir = tmp();
      corruptSecret(dir);
      const goFile = join(tmp(), "go");
      const racers = Array.from({ length: RACERS }, () => racer(dir, goFile));
      // Release them only once every child is up, so they all enter `serverSecret` together.
      await Promise.all(racers.map((r) => r.ready));
      writeFileSync(goFile, "go");
      const runs = await Promise.all(racers.map((r) => r.done));
      expect(runs.map((r) => r.code)).toEqual(Array(RACERS).fill(0));
      const final = readFileSync(secretFile(dir), "utf8").trim();
      expect(final).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new Set(runs.map((r) => r.out))).toEqual(new Set([final]));
    },
    stallTimeout(60_000),
  );

  it("a repair lock left by a crashed repairer does not wedge the next start", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = `${secretFile(dir)}.repair-lock`;
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const key = serverSecret(dir);
    expect(readFileSync(secretFile(dir), "utf8").trim()).toBe(key);
  });
});

describe("a previously exposed secret", () => {
  it.skipIf(process.platform === "win32")(
    "is refused with advice to delete it, not to chmod it, and is not adopted",
    () => {
      const dir = tmp();
      mkdirSync(join(dir, "server-secrets"), { mode: 0o700 });
      writeFileSync(secretFile(dir), "A".repeat(43), { mode: 0o644 });
      chmodSync(secretFile(dir), 0o644);
      let msg = "";
      try {
        serverSecret(dir);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/delete/i);
      expect(msg).toMatch(/regenerat/i);
      expect(msg).not.toMatch(/chmod 0?600/i);
      expect(readFileSync(secretFile(dir), "utf8")).toBe("A".repeat(43));
    },
  );
});

describe("HITL codec boot line", () => {
  const written = (spy: { mock: { calls: unknown[][] } }): string =>
    spy.mock.calls.map((c) => String(c[0])).join("");

  it(
    "names the stable file key when a cacheDir is set",
    async () => {
      const dir = tmp();
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const app = await bootHitl({ auth: hsConfig(), cacheDir: dir });
      try {
        expect(written(spy)).toMatch(/elicit: .*server-secrets.*stable/);
      } finally {
        await app.close();
      }
    },
    stallTimeout(25_000),
  );

  it(
    "names the per-process random key when there is no cacheDir",
    async () => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const app = await bootHitl({ auth: hsConfig() });
      try {
        expect(written(spy)).toMatch(/elicit: .*per-process random key/);
      } finally {
        await app.close();
      }
    },
    stallTimeout(25_000),
  );
});
