// Residuals from the server-local secret review: concurrent repair of a corrupt key, the refusal
// message for an exposed key, and the HITL boot line.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerRecord, serverSecret } from "../src/auth/server-secret";
import { bootHitl, hsConfig } from "./hitl-wire-helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const tmp = (prefix = "obtc-secret-fu-"): string => {
  const d = makeTempDir(prefix);
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
const lockOf = (dir: string): string => `${secretFile(dir)}.repair-lock`;

const corruptSecret = (dir: string): void => {
  mkdirSync(join(dir, "server-secrets"), { mode: 0o700 });
  writeFileSync(secretFile(dir), "truncated", { mode: 0o600 });
  chmodSync(secretFile(dir), 0o600);
};

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < stallTimeout(20_000) / 50 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(cond()).toBe(true);
};

/** A repair lock held by `owner` (the raw `owner` file text), as another process would leave it. */
const lockHeldBy = (dir: string, owner: string): string => {
  const lock = lockOf(dir);
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, "owner"), owner, { mode: 0o600 });
  return lock;
};

/** An owner record for a process on this host that has exited: a provably dead holder. */
const deadHolder = (token: string): string => {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  return JSON.stringify({ ...ownerRecord(token), pid, start: undefined });
};

const errorOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

interface Racer {
  kill: () => void;
  ready: Promise<void>;
  done: Promise<{ code: number | null; out: string; err: string }>;
}

/** A child that prints `ready`, waits for `goFile`, then prints the key `serverSecret` returned. */
function racer(
  dir: string,
  goFile: string,
  cfg: {
    staleMs?: number;
    waitMs?: number;
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
  return { kill: () => p.kill("SIGKILL"), ready, done };
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
    "a live holder stalled past the stale threshold is never taken over",
    async () => {
      const dir = tmp();
      corruptSecret(dir);
      const scratch = tmp();
      const goFile = join(scratch, "go");
      const release = join(scratch, "release");
      writeFileSync(goFile, "go");
      // The holder takes the repair lock and freezes there, alive, until `release` appears.
      const holder = racer(dir, goFile, { stallUntil: release });
      await holder.ready;
      await until(() => existsSync(join(lockOf(dir), "owner")));
      // Time alone never lets a waiter into its lock: they fail closed and name it.
      const racersGo = join(scratch, "racers-go");
      const racers = Array.from({ length: 4 }, () =>
        racer(dir, racersGo, { staleMs: 100, waitMs: 1_500 }),
      );
      await Promise.all(racers.map((r) => r.ready));
      writeFileSync(racersGo, "go");
      const raced = await Promise.all(racers.map((r) => r.done));
      expect(raced.map((r) => r.code)).toEqual(Array(4).fill(1));
      for (const r of raced) expect(r.err).toContain(lockOf(dir));
      expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
      writeFileSync(release, "go");
      const late = await holder.done;
      const final = readFileSync(secretFile(dir), "utf8").trim();
      expect(late.code).toBe(0);
      expect(final).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(late.out).toBe(final);
    },
    stallTimeout(60_000),
  );

  it.skipIf(process.platform === "win32")(
    "a holder killed mid-repair is taken over at once and every racer converges",
    async () => {
      const dir = tmp();
      corruptSecret(dir);
      const scratch = tmp();
      const goFile = join(scratch, "go");
      writeFileSync(goFile, "go");
      const holder = racer(dir, goFile, { stallUntil: join(scratch, "never") });
      await holder.ready;
      await until(() => existsSync(join(lockOf(dir), "owner")));
      holder.kill();
      await holder.done;
      // The lock is fresh (staleMs is an hour): only the holder's death lets the others in.
      const racersGo = join(scratch, "racers-go");
      const racers = Array.from({ length: 6 }, () => racer(dir, racersGo, { staleMs: 3_600_000 }));
      await Promise.all(racers.map((r) => r.ready));
      writeFileSync(racersGo, "go");
      const raced = await Promise.all(racers.map((r) => r.done));
      const final = readFileSync(secretFile(dir), "utf8").trim();
      expect(raced.map((r) => r.code)).toEqual(Array(6).fill(0));
      expect(final).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new Set(raced.map((r) => r.out))).toEqual(new Set([final]));
      expect(existsSync(lockOf(dir))).toBe(false);
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
    "a holder stalled just before it moves the key aside cannot be taken over, so the key never splits",
    async () => {
      const dir = tmp();
      corruptSecret(dir);
      const scratch = tmp();
      const goFile = join(scratch, "go");
      const releaseMove = join(scratch, "release-move");
      writeFileSync(goFile, "go");
      // The holder owns the lock and has re-read the file as corrupt when it freezes, alive.
      const holder = racer(dir, goFile, { stallBeforeMove: releaseMove });
      await holder.ready;
      await until(() => existsSync(join(lockOf(dir), "owner")));
      const racersGo = join(scratch, "racers-go");
      const racers = Array.from({ length: 4 }, () =>
        racer(dir, racersGo, { staleMs: 100, waitMs: 1_500 }),
      );
      await Promise.all(racers.map((r) => r.ready));
      writeFileSync(racersGo, "go");
      const raced = await Promise.all(racers.map((r) => r.done));
      // Nobody installed a key behind the frozen holder's back, where it would move it aside on waking.
      expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
      expect(raced.map((r) => r.out)).toEqual(Array(4).fill(""));
      writeFileSync(releaseMove, "go");
      const late = await holder.done;
      const final = readFileSync(secretFile(dir), "utf8").trim();
      expect(late.code).toBe(0);
      expect(late.out).toBe(final);
      const third = racer(dir, racersGo, {});
      await third.ready;
      expect((await third.done).out).toBe(final);
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

  it("a lock with no owner that cannot be removed fails within the deadline, naming the lock", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockOf(dir);
    mkdirSync(lock);
    writeFileSync(join(lock, "unrelated"), "x"); // a non-empty directory: rmdir refuses
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const t0 = performance.now();
    const msg = errorOf(() => serverSecret(dir, { staleMs: 100, waitMs: 600 }));
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
    const lock = lockOf(dir);
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

  it("a lock creator that stalls before writing its owner cannot overwrite the replacement lock's owner", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockOf(dir);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let swapped = false;
    const msg = errorOf(() =>
      serverSecret(dir, {
        waitMs: 300,
        afterLockMade: () => {
          if (swapped) return;
          swapped = true;
          // A racer judged this fresh, ownerless directory stale, removed it and made its own.
          rmdirSync(lock);
          mkdirSync(lock, { mode: 0o700 });
          writeFileSync(join(lock, "owner"), "B-token", { mode: 0o600 });
        },
      }),
    );
    expect(swapped).toBe(true);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("B-token");
    expect(msg).toContain(lock);
    expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated"); // nobody repaired it
  });

  it("a lock that keeps vanishing under its creator stays within the deadline", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockOf(dir);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let made = 0;
    const msg = errorOf(() =>
      serverSecret(dir, {
        waitMs: 25,
        afterLockMade: () => {
          made++;
          if (made <= 5_000) rmdirSync(lock);
        },
      }),
    );
    expect(msg).toContain(lock);
    expect(made).toBeLessThan(200); // bounded by the deadline plus backoff, not by retries
  });

  it("a repair lock left by a crashed repairer with no owner does not wedge the next start", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockOf(dir);
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const key = serverSecret(dir);
    expect(readFileSync(secretFile(dir), "utf8").trim()).toBe(key);
  });

  it("a holder on another host is never taken over, and the error says what to remove", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockHeldBy(
      dir,
      JSON.stringify({ token: "t", pid: 2_147_483_000, scope: "another-host" }),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const msg = errorOf(() => serverSecret(dir, { staleMs: 50, waitMs: 400 }));
    expect(msg).toContain(lock);
    expect(msg).toMatch(/another-host/);
    expect(msg).toMatch(/stop every obsidian-tc process/i);
    expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
  });

  it("an owner token that cannot be read as a holder is never taken over", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockHeldBy(dir, "not-a-holder-record");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const msg = errorOf(() => serverSecret(dir, { staleMs: 50, waitMs: 400 }));
    expect(msg).toContain(lock);
    expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
  });

  it("a live holder (this process, same start time) is never taken over", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockHeldBy(dir, JSON.stringify(ownerRecord("live")));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const msg = errorOf(() => serverSecret(dir, { staleMs: 50, waitMs: 400 }));
    expect(msg).toContain(lock);
    expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
  });

  it("a lock re-made by a live holder after a waiter judged the old one dead is left alone", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockHeldBy(dir, deadHolder("dead"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let swapped = false;
    const live = JSON.stringify(ownerRecord("live"));
    const msg = errorOf(() =>
      serverSecret(dir, {
        waitMs: 300,
        beforeTakeOver: () => {
          if (swapped) return;
          swapped = true;
          rmSync(lock, { recursive: true });
          lockHeldBy(dir, live);
        },
      }),
    );
    expect(swapped).toBe(true);
    expect(msg).toContain(lock);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe(live);
    expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
  });

  it("a takeover ticket left by a waiter that died mid-takeover fails closed, naming it", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockHeldBy(dir, deadHolder("dead"));
    writeFileSync(`${lock}.takeover.dead`, "", { mode: 0o600 });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const msg = errorOf(() => serverSecret(dir, { waitMs: 300 }));
    expect(msg).toContain(lock);
    expect(msg).toContain(`${lock}.takeover.*`);
    expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
  });

  it("a holder that died is taken over in-process, without waiting for the stale threshold", () => {
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockHeldBy(dir, deadHolder("dead"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const key = serverSecret(dir, { staleMs: 3_600_000, waitMs: 3_000 });
    expect(readFileSync(secretFile(dir), "utf8").trim()).toBe(key);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover.dead`)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "a pid reused by an unrelated process (start time differs) is not mistaken for the holder",
    () => {
      const dir = tmp();
      corruptSecret(dir);
      lockHeldBy(dir, JSON.stringify({ ...ownerRecord("reused"), start: "1" }));
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const key = serverSecret(dir, { waitMs: 3_000 });
      expect(readFileSync(secretFile(dir), "utf8").trim()).toBe(key);
      expect(existsSync(lockOf(dir))).toBe(false);
    },
  );
});

describe("a previously exposed secret", () => {
  it.skipIf(process.platform === "win32")(
    "is refused with advice to delete it, not to chmod it, and is not adopted",
    () => {
      const dir = tmp();
      mkdirSync(join(dir, "server-secrets"), { mode: 0o700 });
      writeFileSync(secretFile(dir), "A".repeat(43), { mode: 0o644 });
      chmodSync(secretFile(dir), 0o644);
      const msg = errorOf(() => serverSecret(dir));
      expect(msg).toMatch(/delete/i);
      expect(msg).toMatch(/regenerat/i);
      expect(msg).not.toMatch(/chmod 0?600/i);
      expect(readFileSync(secretFile(dir), "utf8")).toBe("A".repeat(43));
    },
  );

  it.skipIf(process.platform === "win32").each([["is corrupt"], ["is empty"]])(
    "is still refused when the cacheDir path says %s",
    (phrase) => {
      const dir = tmp(`obtc ${phrase}-`);
      mkdirSync(join(dir, "server-secrets"), { mode: 0o700 });
      writeFileSync(secretFile(dir), "A".repeat(43), { mode: 0o644 });
      chmodSync(secretFile(dir), 0o644);
      const written: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((s) => {
        written.push(String(s));
        return true;
      });
      const msg = errorOf(() => serverSecret(dir));
      expect(msg).toMatch(/delete/i);
      expect(written.join("")).not.toMatch(/regenerating/);
      expect(readFileSync(secretFile(dir), "utf8")).toBe("A".repeat(43)); // not regenerated
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
