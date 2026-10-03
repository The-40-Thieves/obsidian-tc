// A config file whose JSON root is not an object (`null`, `123`, `"x"`, `false`, an array) used to
// reach `"cacheDir" in raw` and the other raw-object readers in config/load.ts and die with a
// TypeError ("Cannot use 'in' operator ..."). It is now a named, typed error from `readConfigFile`,
// the one place every caller reads the file through.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSetup } from "../src/cli/parse-setup";
import { ConfigRootTypeError, loadConfig, readConfigFile } from "../src/config/load";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmTemp(dirs.pop() as string);
});

function configWith(content: string): string {
  const dir = makeTempDir("config-root-type-");
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, content);
  return path;
}

describe("config root must be an object", () => {
  it.each([
    ["null", "null", "null"],
    ["123", "123", "number"],
    ['"x"', '"x"', "string"],
    ["false", "false", "boolean"],
    ["[]", "[]", "array"],
  ])("%s -> ConfigRootTypeError naming the root type (never a TypeError)", (_n, content, kind) => {
    const path = configWith(content);
    for (const read of [() => readConfigFile(path), () => loadConfig(path)]) {
      let thrown: unknown;
      try {
        read();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConfigRootTypeError);
      expect(thrown).not.toBeInstanceOf(TypeError);
      expect((thrown as ConfigRootTypeError).rootType).toBe(kind);
      expect((thrown as Error).message).toMatch(/config root must be an object/i);
    }
  });

  it("an object root (even empty) still parses", () => {
    expect(readConfigFile(configWith("{}"))).toEqual({});
  });
});

describe("setup --replace-invalid-config flag", () => {
  it("is parsed, off by default and NOT implied by --force", () => {
    expect(parseSetup(["--replace-invalid-config"]).replaceInvalidConfig).toBe(true);
    expect(parseSetup(["--force", "--yes"]).replaceInvalidConfig).toBe(false);
  });
});
