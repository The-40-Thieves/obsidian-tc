// PR B of GH #995's two-part follow-up: pure unit tests for cli/setup/first-run-fallback.ts's
// gating/formatting logic — no filesystem, no detection pass. See test/setup-first-run-e2e.test.ts
// for the real detect()+writeSetupConfig() path.
import { describe, expect, it } from "vitest";
import {
  formatFirstRunFallbackDeclinedHint,
  formatFirstRunSetupNotice,
  NO_AUTO_SETUP_ENV_VAR,
  shouldAttemptFirstRunFallback,
} from "../src/cli/setup/first-run-fallback";

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
