// PR B of GH #995's two-part follow-up: pure unit tests for cli/setup/first-run-fallback.ts's
// gating/formatting logic — no filesystem, no detection pass. See test/setup-first-run-e2e.test.ts
// for the real detect()+writeSetupConfig() path.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSetupConfigPath } from "../src/cli/resolve-config";
import {
  formatFirstRunFallbackDeclinedHint,
  formatFirstRunSetupNotice,
  NO_AUTO_SETUP_ENV_VAR,
  shouldAttemptFirstRunFallback,
} from "../src/cli/setup/first-run-fallback";
import { makeTempDir, rmTemp, stubHomedir } from "./tmp";

// Finding 5 (fix round, cross-vendor review): `shouldAttemptFirstRunFallback`'s own last check is
// `!existsSync(defaultSetupConfigPath())` — a REAL filesystem read against the ACTUAL home dir
// unless it is stubbed. Every test below used to call it with no `stubHomedir`, so a developer (or
// CI job) that already has `~/.obsidian-tc/config.json` on the box running the suite would see
// these "is true"/opt-out assertions flip to `false` for a reason that has nothing to do with the
// gating logic under test.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = makeTempDir(prefix);
  tmpDirs.push(d);
  return d;
};
let restoreHome: (() => void) | undefined;

beforeEach(() => {
  restoreHome = stubHomedir(tmpDir("otc-first-run-gate-home-"));
});

afterEach(() => {
  restoreHome?.();
  restoreHome = undefined;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best-effort */
    }
  }
});

describe("shouldAttemptFirstRunFallback", () => {
  it("is false when an input path/positional was given", () => {
    expect(shouldAttemptFirstRunFallback({ input: "/some/vault", env: {} })).toBe(false);
  });

  it("is false when OBSIDIAN_TC_CONFIG is set", () => {
    expect(
      shouldAttemptFirstRunFallback({
        input: undefined,
        env: { OBSIDIAN_TC_CONFIG: "/some/config.json" },
      }),
    ).toBe(false);
  });

  it('is false when the opt-out env var is set to "1"', () => {
    expect(
      shouldAttemptFirstRunFallback({ input: undefined, env: { [NO_AUTO_SETUP_ENV_VAR]: "1" } }),
    ).toBe(false);
  });

  it("does NOT treat any other value of the opt-out var as opting out", () => {
    // Only the literal "1" opts out — same strictness as every other OBSIDIAN_TC_* boolean-ish
    // env var in this repo (never "true"/"yes" as a silent alias).
    expect(
      shouldAttemptFirstRunFallback({ input: undefined, env: { [NO_AUTO_SETUP_ENV_VAR]: "yes" } }),
    ).toBe(true);
  });

  it("is true when no input, no env override, no opt-out — and the default config does not exist", () => {
    expect(shouldAttemptFirstRunFallback({ input: undefined, env: {} })).toBe(true);
  });

  it("is false when the default config already exists (the stubbed home, not the real one)", () => {
    const target = defaultSetupConfigPath();
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "{}");
    expect(shouldAttemptFirstRunFallback({ input: undefined, env: {} })).toBe(false);
  });

  // Finding 6 (fix round, cross-vendor review): the MCPB manifest spec's own optional
  // `${user_config.X}` placeholder, left unsubstituted by a host (or a blank config_path), reaches
  // `serve` as a real, defined string — `resolve-config.ts`'s own `normalizeConfigPathInput` /
  // `isUnusableInput` already treat both as "no input" for the REST of config resolution, but this
  // gate checked only `input !== undefined` and read either shape as "input WAS given", so a
  // first-time Claude Desktop MCPB launch with a blank field never triggered the fallback at all —
  // the exact first-run shape this feature exists for.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal MCPB placeholder text under test.
  const MCPB_PLACEHOLDER = "${user_config.config_path}";

  it("finding 6: an unsubstituted MCPB placeholder is treated as no-input, same as undefined", () => {
    expect(shouldAttemptFirstRunFallback({ input: MCPB_PLACEHOLDER, env: {} })).toBe(true);
  });

  it("finding 6: an empty-string input is treated as no-input, same as undefined", () => {
    expect(shouldAttemptFirstRunFallback({ input: "", env: {} })).toBe(true);
  });

  it("finding 6: a REAL input path still short-circuits the fallback", () => {
    expect(shouldAttemptFirstRunFallback({ input: "/real/vault", env: {} })).toBe(false);
  });
});

describe("formatFirstRunSetupNotice", () => {
  it("names the path and vault for a written config", () => {
    const text = formatFirstRunSetupNotice({
      outcome: "written",
      path: "/home/op/.obsidian-tc/config.json",
      config: {
        vaults: [{ id: "main", path: "/vaults/main" }],
      } as unknown as import("@the-40-thieves/obsidian-tc-shared").ServerConfig,
    });
    expect(text).toContain("/home/op/.obsidian-tc/config.json");
    expect(text).toContain("main: /vaults/main");
    expect(text).toContain("obsidian-tc setup");
  });

  it("names a raced write as written by another process", () => {
    const text = formatFirstRunSetupNotice({
      outcome: "raced",
      path: "/home/op/.obsidian-tc/config.json",
      config: {
        vaults: [{ id: "main", path: "/vaults/main" }],
      } as unknown as import("@the-40-thieves/obsidian-tc-shared").ServerConfig,
    });
    expect(text).toMatch(/another obsidian-tc process/);
  });
});

describe("formatFirstRunFallbackDeclinedHint", () => {
  it("carries the decline reason and points at `obsidian-tc setup`", () => {
    const text = formatFirstRunFallbackDeclinedHint("2 vaults were found");
    expect(text).toContain("2 vaults were found");
    expect(text).toContain("obsidian-tc setup");
  });
});
