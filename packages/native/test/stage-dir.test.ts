// Unit tests for scripts/lib/stage-dir.mjs (THE-1080, #948). Real temp-dir fs for createStageDir
// (mkdtemp itself is the thing under test); sweepStaleStageDirs is exercised with both real fs
// (age-based deletion) and an injected clock/fs to avoid sleeping in the suite.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createStageDir,
  STAGE_DIR_PREFIX,
  sweepStaleStageDirs,
} from "../scripts/lib/stage-dir.mjs";

describe("createStageDir", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "stage-dir-target-"));
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("creates a directory under targetDir prefixed with STAGE_DIR_PREFIX", () => {
    const stageDir = createStageDir(targetDir);
    expect(stageDir.startsWith(join(targetDir, STAGE_DIR_PREFIX))).toBe(true);
    expect(existsSync(stageDir)).toBe(true);
  });

  it("gives two invocations distinct directories (the concurrency bug this replaces)", () => {
    const first = createStageDir(targetDir);
    const second = createStageDir(targetDir);
    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });
});

describe("sweepStaleStageDirs", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "stage-dir-target-"));
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("removes only napi-stage-* directories older than maxAgeMs", () => {
    const stale = join(targetDir, `${STAGE_DIR_PREFIX}stale`);
    mkdirSync(stale);
    const fresh = join(targetDir, `${STAGE_DIR_PREFIX}fresh`);
    mkdirSync(fresh);
    const unrelated = join(targetDir, "not-a-stage-dir");
    mkdirSync(unrelated);

    const now = Date.now();
    const oneHourMs = 60 * 60 * 1000;
    const fakeStat = (path: string) => {
      // "stale" reports as created two hours ago; everything else reports as brand new.
      const mtimeMs = path.endsWith(`${STAGE_DIR_PREFIX}stale`) ? now - 2 * oneHourMs : now;
      return { mtimeMs };
    };

    sweepStaleStageDirs({ targetDir, now, maxAgeMs: oneHourMs, statFn: fakeStat as never });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("never throws when targetDir does not exist", () => {
    expect(() =>
      sweepStaleStageDirs({ targetDir: join(targetDir, "does-not-exist") }),
    ).not.toThrow();
  });

  it("never throws when rmFn fails on one entry (a still-live invocation owns it)", () => {
    mkdirSync(join(targetDir, `${STAGE_DIR_PREFIX}busy`));
    const rmFn = () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    };

    expect(() =>
      sweepStaleStageDirs({ targetDir, now: Date.now() + 10 * 60 * 60 * 1000, maxAgeMs: 0, rmFn }),
    ).not.toThrow();
    // Left in place -- the sweep is best-effort, not a guarantee.
    expect(existsSync(join(targetDir, `${STAGE_DIR_PREFIX}busy`))).toBe(true);
  });

  it("ignores directories that don't match STAGE_DIR_PREFIX regardless of age", () => {
    mkdirSync(join(targetDir, "release"));
    sweepStaleStageDirs({ targetDir, now: Date.now() + 10 * 60 * 60 * 1000, maxAgeMs: 0 });
    expect(readdirSync(targetDir)).toContain("release");
  });
});
