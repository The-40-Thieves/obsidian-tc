import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/cli/cli-error";
import { defaultSetupConfigPath, resolveServeConfig } from "../src/cli/resolve-config";
import { rmTemp, stubHomedir } from "./tmp";

// A config FILE that parses as JSON but fails the schema (the reported case: a `{}` left at
// ~/.obsidian-tc/config.json) used to surface as a raw Zod issue array — no file named, no way
// out. All three ways of naming a file share resolveServeConfigWithProvenance's one validation.
const ENV_KEY = "OBSIDIAN_TC_CONFIG";

const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

describe("resolveServeConfig — a config file that fails schema validation", () => {
  const ORIGINAL_ENV = process.env[ENV_KEY];
  let restoreHome: (() => void) | undefined;

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmTemp(d);
    restoreHome?.();
    restoreHome = undefined;
    if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = ORIGINAL_ENV;
  });

  function catchError(fn: () => unknown): Error {
    try {
      fn();
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected the call to throw");
  }

  it("default-path `{}`: CliError naming the file and the missing field, with the way out", () => {
    const home = tmpDir("otc-invalid-default-");
    mkdirSync(join(home, ".obsidian-tc"), { recursive: true });
    writeFileSync(defaultPathIn(home), "{}");
    restoreHome = stubHomedir(home);
    delete process.env[ENV_KEY];

    const e = catchError(() => resolveServeConfig(undefined));
    expect(e).toBeInstanceOf(CliError);
    expect(e.message).toContain(defaultSetupConfigPath());
    expect(e.message).toContain("is not a valid config: vaults is required");
    expect(e.message).toContain("obsidian-tc setup");
    expect(e.message).toContain("pass a vault folder");
    expect(e.message).not.toContain('"code"'); // no raw Zod JSON dump
  });

  it("OBSIDIAN_TC_CONFIG target: same error, naming THAT file", () => {
    const dir = tmpDir("otc-invalid-env-");
    const file = join(dir, "env.json");
    writeFileSync(file, "{}");
    process.env[ENV_KEY] = file;
    const e = catchError(() => resolveServeConfig(undefined));
    expect(e).toBeInstanceOf(CliError);
    expect(e.message).toContain(`${file} is not a valid config: vaults is required`);
  });

  it("explicit path target: same error, and a wrong-typed field keeps Zod's message under its dotted path", () => {
    const dir = tmpDir("otc-invalid-explicit-");
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ vaults: [{ id: "v", path: dir }], plane: "nope" }));
    const e = catchError(() => resolveServeConfig(file));
    expect(e).toBeInstanceOf(CliError);
    expect(e.message).toContain(`${file} is not a valid config: plane: `);
    expect(e.message).not.toContain("is required");
  });

  it("several problems are all reported on one line", () => {
    const dir = tmpDir("otc-invalid-multi-");
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ plane: "nope" }));
    const e = catchError(() => resolveServeConfig(file));
    expect(e.message).toContain("vaults is required; plane: ");
    expect(e.message.trim().split("\n")).toHaveLength(1);
  });
});

function defaultPathIn(home: string): string {
  return join(home, ".obsidian-tc", "config.json");
}
