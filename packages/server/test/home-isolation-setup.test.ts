import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSetupConfigPath } from "../src/cli/resolve-config";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

// Pins test/home-isolation-setup.ts (a vitest setupFiles entry): every test file starts with
// `homedir()` under a throwaway temp dir, never the developer's real home.
describe("home isolation setup", () => {
  it("homedir() is a temp dir under tmpdir(), on both POSIX (HOME) and Windows (USERPROFILE)", () => {
    expect(homedir().startsWith(join(tmpdir(), "otc-test-home-"))).toBe(true);
    expect(process.env.HOME).toBe(homedir());
    expect(process.env.USERPROFILE).toBe(homedir());
  });

  it("the default setup config path resolves inside the pinned home and does not exist there", () => {
    expect(defaultSetupConfigPath().startsWith(homedir())).toBe(true);
    expect(existsSync(defaultSetupConfigPath())).toBe(false);
  });

  describe.skipIf(!bunAvailable)("shared Bun transpiler cache", () => {
    it("is outside isolated temp homes and inherited by Bun children", () => {
      const cachePath = process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
      expect(cachePath).toBeDefined();
      expect(isAbsolute(cachePath ?? "")).toBe(true);

      const homeRelative = relative(homedir(), cachePath ?? "");
      const tempRelative = relative(tmpdir(), cachePath ?? "");
      expect(homeRelative.startsWith("..") || isAbsolute(homeRelative)).toBe(true);
      expect(tempRelative.startsWith("..") || isAbsolute(tempRelative)).toBe(true);

      const child = spawnSync(
        "bun",
        ["-e", "process.stdout.write(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? '')"],
        { env: process.env, encoding: "utf8" },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toBe(cachePath);
    });
  });
});
