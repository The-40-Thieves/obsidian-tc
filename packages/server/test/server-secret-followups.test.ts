// Residuals from the server-local secret review: concurrent repair of a corrupt key, the refusal
// message for an exposed key, and the HITL boot line.
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  done: Promise<{ code: number | null; out: string; err: string }>;
}

/** A child that prints `ready`, waits for `goFile`, then prints the key `serverSecret` returned. */
function racer(
  dir: string,
  goFile: string,
  cfg: {
    staleMs?: number;
    stallUntil?: string;
    stallBeforeMove?: string;
    stallInGap?: string;
  } = {},
): Racer {
  const p = spawn("bun", [join(here, "server-secret-child.ts"), dir, goFile, JSON.stringify(cfg)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(p);
  let out = "";
  let err = "";
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  p.stderr.on("data", (b) => {
    err += b;
  });
  p.stdout.on("data", (b) => {
    out += b;
    if (out.includes("ready\n")) markReady();
  });
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    p.on("close", (code) => {
      markReady();
      resolve({ code, out: out.replace(/^ready\n/, ""), err });
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
      expect(runs.filter((r) => r.code !== 0).map((r) => r.err.slice(-400))).toEqual([]);
      expect(runs.map((r) => r.code)).toEqual(Array(RACERS).fill(0));
      const final = readFileSync(secretFile(dir), "utf8").trim();
      expect(final).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new Set(runs.map((r) => r.out))).toEqual(new Set([final]));
    },
    stallTimeout(60_000),
  );

  it(
    "a live repairer stalled past the stale threshold cannot split the instance key",
    async () => {
      const dir = tmp();
      corruptSecret(dir);
      const scratch = tmp();
      const goFile = join(scratch, "go");
      const release = join(scratch, "release");
      const lockOwner = `${secretFile(dir)}.repair-lock`;
      writeFileSync(goFile, "go");
      // The holder takes the repair lock and freezes there, alive, until `release` appears.
      const holder = racer(dir, goFile, { stallUntil: release });
      await holder.ready;
      for (let i = 0; i < stallTimeout(20_000) / 50 && !existsSync(lockOwner); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(lockOwner)).toBe(true);
      // Others find its lock stale, take it over, repair, and finish while it is still frozen.
      const racersGo = join(scratch, "racers-go");
      const racers = Array.from({ length: 6 }, () => racer(dir, racersGo, { staleMs: 300 }));
      await Promise.all(racers.map((r) => r.ready));
      writeFileSync(racersGo, "go");
      const raced = await Promise.all(racers.map((r) => r.done));
      // The holder wakes only now, holding a lock that is no longer its own.
      writeFileSync(release, "go");
      const late = await holder.done;
      const final = readFileSync(secretFile(dir), "utf8").trim();
      expect([...raced, late].filter((r) => r.code !== 0).map((r) => r.err.slice(-400))).toEqual(
        [],
      );
      expect([...raced, late].map((r) => r.code)).toEqual(Array(7).fill(0));
      expect(final).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new Set([...raced, late].map((r) => r.out))).toEqual(new Set([final]));
    },
    stallTimeout(60_000),
  );

  it(
    "24 racers on a valid key all return that key and leave the file unchanged",
    async () => {
      const dir = tmp();
      const initial = serverSecret(dir);
      const goFile = join(tmp(), "go");
      const racers = Array.from({ length: RACERS }, () => racer(dir, goFile));
      await Promise.all(racers.map((r) => r.ready));
      writeFileSync(goFile, "go");
      const runs = await Promise.all(racers.map((r) => r.done));
      expect(runs.filter((r) => r.code !== 0).map((r) => r.err.slice(-400))).toEqual([]);
      expect(new Set(runs.map((r) => r.out))).toEqual(new Set([initial]));
      expect(readFileSync(secretFile(dir), "utf8").trim()).toBe(initial);
    },
    stallTimeout(60_000),
  );

  it(
    "a stale repairer that passed the ownership check cannot move a valid key aside or split it",
    async () => {
      const dir = tmp();
      corruptSecret(dir);
      const scratch = tmp();
      const goFile = join(scratch, "go");
      const releaseMove = join(scratch, "release-move");
      const releaseGap = join(scratch, "release-gap");
      const lockOwner = `${secretFile(dir)}.repair-lock`;
      writeFileSync(goFile, "go");
      // The holder owns the lock when it freezes just before moving the corrupt file aside.
      const holder = racer(dir, goFile, { stallBeforeMove: releaseMove, stallInGap: releaseGap });
      await holder.ready;
      for (let i = 0; i < stallTimeout(20_000) / 50 && !existsSync(lockOwner); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(lockOwner)).toBe(true);
      // Its lock goes stale: others take it over and publish the key the instance will keep.
      const racersGo = join(scratch, "racers-go");
      const racers = Array.from({ length: 6 }, () => racer(dir, racersGo, { staleMs: 300 }));
      await Promise.all(racers.map((r) => r.ready));
      writeFileSync(racersGo, "go");
      const raced = await Promise.all(racers.map((r) => r.done));
      const keep = readFileSync(secretFile(dir), "utf8").trim();
      expect(keep).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The holder wakes holding a stale view of a corrupt file. If it moves the now-valid key
      // aside, a third process must still not mint its own key into that gap.
      let holderDone = false;
      void holder.done.then(() => {
        holderDone = true;
      });
      writeFileSync(releaseMove, "go");
      for (let i = 0; i < stallTimeout(10_000) / 20 && !holderDone; i++) {
        if (!existsSync(secretFile(dir))) break; // the holder has the key aside
        await new Promise((r) => setTimeout(r, 20));
      }
      const third = racer(dir, racersGo, {});
      await third.ready;
      const thirdRun = await third.done;
      writeFileSync(releaseGap, "go");
      const late = await holder.done;
      const all = [...raced, thirdRun, late];
      expect(all.filter((r) => r.code !== 0).map((r) => r.err.slice(-400))).toEqual([]);
      expect(new Set(all.map((r) => r.out))).toEqual(new Set([keep]));
      expect(readFileSync(secretFile(dir), "utf8").trim()).toBe(keep);
    },
    stallTimeout(60_000),
  );

  it.skipIf(process.platform === "win32")(
    "a reader never errors on the instant the key is absent while a repairer has it aside",
    async () => {
      const dir = tmp();
      const initial = serverSecret(dir);
      const stopFile = join(tmp(), "stop-mover");
      const mover = spawn(
        "bun",
        [join(here, "server-secret-mover.ts"), secretFile(dir), stopFile],
        {
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      children.push(mover);
      const moverExit = new Promise<number | null>((resolve) => {
        mover.once("close", (code) => resolve(code));
      });
      await new Promise<void>((resolve) => {
        mover.stdout.once("data", () => resolve());
      });
      // A call that opens the path in the gap must wait for the lock holder and adopt the key it
      // puts back: never throw ENOENT, never publish a different key.
      for (let i = 0; i < 5_000; i++) {
        expect(serverSecret(dir)).toBe(initial);
      }
      // The mover was running (the key was being moved aside) for the whole read loop.
      expect(mover.exitCode).toBeNull();
      // Stop it and wait for the exit: it stops between iterations, so the key is back in place. A read
      // while it is alive races the next move-aside and can see ENOENT, which is the test's own read
      // failing, not a reader.
      writeFileSync(stopFile, "stop");
      expect(await moverExit).toBe(0);
      expect(readFileSync(secretFile(dir), "utf8").trim()).toBe(initial);
    },
    stallTimeout(60_000),
  );

  it("a stale lock that cannot be removed fails within the deadline, naming the lock", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = `${secretFile(dir)}.repair-lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, "unrelated"), "x"); // a non-empty directory: rmdir refuses
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const t0 = performance.now();
    let msg = "";
    try {
      serverSecret(dir, { staleMs: 100, waitMs: 600 });
    } catch (e) {
      msg = (e as Error).message;
    }
    const elapsed = performance.now() - t0;
    expect(msg).toContain(lock);
    expect(msg).toMatch(/delete/i);
    expect(elapsed).toBeGreaterThanOrEqual(500); // it waited out the deadline, not a hot retry
    expect(elapsed).toBeLessThan(stallTimeout(5_000));
    expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
  });

  it("a lock a racer judged stale and removed before its owner token was written is taken again", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = `${secretFile(dir)}.repair-lock`;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let removed = false;
    const key = serverSecret(dir, {
      afterLockMade: () => {
        if (removed) return;
        removed = true;
        rmdirSync(lock); // what a stale-breaker does to a lock whose creator is slow to write `owner`
      },
    });
    expect(removed).toBe(true);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(secretFile(dir), "utf8").trim()).toBe(key);
    expect(existsSync(lock)).toBe(false);
  });

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
