// Pins tmp.ts's `stubHomedir` failing closed when `os.homedir()` does not follow a runtime HOME
// change. Bun 1.4.3 reads HOME once at startup, so under it every per-test stub and the setup file
// (home-isolation-setup.ts) would be silently inert and tests would write the developer's real home.
//
// The mock lives in its own file (like first-run-fallback-wx-race.test.ts) so it cannot reach the
// other files. It defaults to the real `homedir`, because home-isolation-setup.ts calls
// `stubHomedir` at setup time, before any test runs; a test flips `ignoreHome` to model Bun.
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, rmTemp, stubHomedir } from "./tmp";

const state = vi.hoisted(() => ({ ignoreHome: false }));

// What a runtime that ignores HOME reports: a fixed path that is neither the stub nor the real home.
const FIXED_HOME = join(tmpdir(), "otc-fixed-home-never-created");

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => (state.ignoreHome ? FIXED_HOME : actual.homedir())),
  };
});

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = makeTempDir(prefix);
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  state.ignoreHome = false;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best-effort */
    }
  }
});

describe("stubHomedir", () => {
  it("points os.homedir() at the given directory, and restores HOME and USERPROFILE", () => {
    const dir = tmpDir("otc-stub-homedir-ok-");
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

    const restore = stubHomedir(dir);
    expect(resolve(homedir())).toBe(resolve(dir));

    restore();
    expect(process.env.HOME).toBe(before.HOME);
    expect(process.env.USERPROFILE).toBe(before.USERPROFILE);
  });

  it("throws when os.homedir() ignores HOME, and leaves HOME and USERPROFILE unchanged", async () => {
    const dir = tmpDir("otc-stub-homedir-red-");
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    state.ignoreHome = true;
    // The setup file already loaded tmp.ts under the real node:os, so re-import it here to bind the
    // mocked homedir.
    vi.resetModules();
    const { stubHomedir: stubWithIgnoredHome } = await import("./tmp");

    expect(() => stubWithIgnoredHome(dir)).toThrow(/os\.homedir\(\) did not follow HOME/);
    expect(process.env.HOME).toBe(before.HOME);
    expect(process.env.USERPROFILE).toBe(before.USERPROFILE);
  });
});
