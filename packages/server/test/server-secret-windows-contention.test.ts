// Windows answers a `mkdir` of the repair lock while another process is deleting it (delete-pending)
// with EPERM/EACCES instead of EEXIST, and a link into such a directory the same way. The lock
// treated that as a failure and crashed the repairer (CI run 37747128809, windows-latest). These
// tests inject those errors on any host and pin: a lost acquisition backs off inside the one
// deadline, converges on one key, never deletes a lock it does not hold, and POSIX still surfaces
// a real permission error.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerRecord, serverSecret } from "../src/auth/server-secret";
import { makeTempDir, rmTemp } from "./tmp";

// Faults to inject, keyed by the operation they hit. Each entry fires `times` more times.
const faults = vi.hoisted(() => ({
  mkdir: undefined as { code: string; times: number } | undefined,
  link: undefined as { code: string; times: number } | undefined,
  rmdir: undefined as { code: string; times: number } | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const inject = (kind: "mkdir" | "link" | "rmdir", p: unknown): void => {
    const f = faults[kind];
    if (f === undefined || f.times <= 0) return;
    if (kind !== "link" && !String(p).endsWith(".repair-lock")) return;
    if (kind === "link" && !String(p).replaceAll("\\", "/").endsWith(".repair-lock/owner")) return;
    f.times--;
    throw Object.assign(new Error(`${f.code}: injected`), { code: f.code });
  };
  return {
    ...real,
    mkdirSync: ((
      p: Parameters<typeof real.mkdirSync>[0],
      o?: Parameters<typeof real.mkdirSync>[1],
    ) => {
      inject("mkdir", p);
      return real.mkdirSync(p, o);
    }) as typeof real.mkdirSync,
    linkSync: ((
      from: Parameters<typeof real.linkSync>[0],
      to: Parameters<typeof real.linkSync>[1],
    ) => {
      inject("link", to);
      return real.linkSync(from, to);
    }) as typeof real.linkSync,
    rmdirSync: ((...a: Parameters<typeof real.rmdirSync>) => {
      inject("rmdir", a[0]);
      return real.rmdirSync(...a);
    }) as typeof real.rmdirSync,
  };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const setPlatform = (value: string): void => {
  Object.defineProperty(process, "platform", { ...realPlatform, value });
};

const dirs: string[] = [];
const tmp = (): string => {
  const d = makeTempDir("obtc-secret-winc-");
  dirs.push(d);
  return d;
};
const secretFile = (dir: string): string => join(dir, "server-secrets", "wiki-generated.key");
const lockOf = (dir: string): string => `${secretFile(dir)}.repair-lock`;
const corruptSecret = (dir: string): void => {
  mkdirSync(join(dir, "server-secrets"), { mode: 0o700 });
  writeFileSync(secretFile(dir), "truncated", { mode: 0o600 });
  chmodSync(secretFile(dir), 0o600);
};
const errorOf = (fn: () => unknown): Error | undefined => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  return undefined;
};

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  faults.mkdir = undefined;
  faults.link = undefined;
  faults.rmdir = undefined;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmTemp(d);
});

describe("repair lock under Windows delete-pending contention", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "%s from mkdir is a lost acquisition: the repairer retries and repairs the key",
    (code) => {
      setPlatform("win32");
      const dir = tmp();
      corruptSecret(dir);
      faults.mkdir = { code, times: 3 };
      const key = serverSecret(dir, { waitMs: 5_000 });
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(readFileSync(secretFile(dir), "utf8")).toBe(key);
      expect(faults.mkdir.times).toBe(0); // all three were hit, none crashed
      expect(existsSync(lockOf(dir))).toBe(false);
    },
  );

  it.each(["EPERM", "EACCES"])(
    "%s from the owner publish (the lock went delete-pending under us) retries and repairs",
    (code) => {
      setPlatform("win32");
      const dir = tmp();
      corruptSecret(dir);
      faults.link = { code, times: 2 };
      const key = serverSecret(dir, { waitMs: 5_000 });
      expect(readFileSync(secretFile(dir), "utf8")).toBe(key);
      expect(faults.link.times).toBe(0);
      expect(existsSync(lockOf(dir))).toBe(false);
    },
  );

  it("EPERM from the lock cleanup (a waiter still holds the directory) is ridden out, not left behind", () => {
    setPlatform("win32");
    const dir = tmp();
    corruptSecret(dir);
    faults.rmdir = { code: "EPERM", times: 3 };
    const key = serverSecret(dir, { waitMs: 5_000 });
    expect(readFileSync(secretFile(dir), "utf8")).toBe(key);
    expect(faults.rmdir.times).toBe(0);
    expect(existsSync(lockOf(dir))).toBe(false); // an ownerless lock would stall others until stale
  });

  it("a contention error that never clears stays bounded by the deadline and fails closed", () => {
    setPlatform("win32");
    const dir = tmp();
    corruptSecret(dir);
    faults.mkdir = { code: "EACCES", times: Number.POSITIVE_INFINITY };
    const t0 = performance.now();
    const err = errorOf(() => serverSecret(dir, { waitMs: 400 }));
    expect(err?.message).toContain("timed out after 400ms");
    expect(err?.message).toContain(lockOf(dir));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(350);
    expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
  });

  it("never touches a live holder's lock while contention is reported", () => {
    setPlatform("win32");
    const dir = tmp();
    corruptSecret(dir);
    const lock = lockOf(dir);
    mkdirSync(lock);
    const owner = JSON.stringify(ownerRecord("live-holder.0"));
    writeFileSync(join(lock, "owner"), owner);
    faults.mkdir = { code: "EPERM", times: Number.POSITIVE_INFINITY };
    const err = errorOf(() => serverSecret(dir, { waitMs: 300, staleMs: 1 }));
    expect(err?.message).toContain(`process ${process.pid}`);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe(owner);
    expect(readFileSync(secretFile(dir), "utf8")).toBe("truncated");
  });

  it("off Windows the same codes are real permission errors and surface", () => {
    setPlatform("linux");
    const dir = tmp();
    corruptSecret(dir);
    faults.mkdir = { code: "EACCES", times: 1 };
    const err = errorOf(() => serverSecret(dir, { waitMs: 300 }));
    expect((err as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");
  });
});
