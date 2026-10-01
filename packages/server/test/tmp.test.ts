// rmTemp (tmp.ts): on Windows a lock error that outlives the retries must not fail the file.
// POSIX cannot produce EPERM/EBUSY from `rmSync` on demand, so the call is faked and the platform
// stubbed; the fake stands in for the one thing a Linux runner cannot reproduce.
import { afterEach, describe, expect, it, vi } from "vitest";

const rm = vi.hoisted(() => ({ fail: undefined as undefined | NodeJS.ErrnoException }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    rmSync: (...args: Parameters<typeof real.rmSync>) => {
      if (rm.fail) throw rm.fail;
      return real.rmSync(...args);
    },
  };
});

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// tmp.ts is already loaded (and bound to the real `rmSync`) by the tmp-guard setup file, so load a
// fresh copy that sees the mock above.
vi.resetModules();
const { makeTempDir, rmTemp } = await import("./tmp");

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted, rm 'x'`), { code });

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const as = (os: string) =>
  Object.defineProperty(process, "platform", { ...realPlatform, value: os });

afterEach(() => {
  rm.fail = undefined;
  Object.defineProperty(process, "platform", realPlatform);
  vi.restoreAllMocks();
});

describe("rmTemp", () => {
  it("removes the directory and its contents", () => {
    const dir = makeTempDir("tmp-rmtemp-");
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    rmTemp(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it.each(["EPERM", "EBUSY", "ENOTEMPTY"])(
    "win32: a residual %s after the retries warns instead of throwing",
    (code) => {
      const dir = makeTempDir("tmp-rmtemp-");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      as("win32");
      rm.fail = errno(code);
      expect(() => rmTemp(dir)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(dir);
      expect(String(warn.mock.calls[0]?.[0])).toContain(code);
      // the leftover is still on disk, so the leak gate would name it; the sweep removes it
      // once the lock is gone
      expect(existsSync(dir)).toBe(true);
      rm.fail = undefined;
      rmTemp(dir);
      expect(existsSync(dir)).toBe(false);
    },
  );

  it("win32: any other error still throws (a real bug is not a lock)", () => {
    const dir = makeTempDir("tmp-rmtemp-");
    as("win32");
    rm.fail = errno("EACCES");
    expect(() => rmTemp(dir)).toThrow(/EACCES/);
    rm.fail = undefined;
    rmTemp(dir);
  });

  it.each(["linux", "darwin"])("%s: EPERM and EBUSY still throw (behaviour unchanged)", (os) => {
    const dir = makeTempDir("tmp-rmtemp-");
    as(os);
    for (const code of ["EPERM", "EBUSY"]) {
      rm.fail = errno(code);
      expect(() => rmTemp(dir)).toThrow(code);
    }
    rm.fail = undefined;
    rmTemp(dir);
  });
});
