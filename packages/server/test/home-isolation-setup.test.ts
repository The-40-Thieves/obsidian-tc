import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSetupConfigPath } from "../src/cli/resolve-config";

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
});
