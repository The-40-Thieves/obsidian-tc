// Unit tests for scripts/lib/napi-invocation.mjs (THE-1080, #948). Pure argv/options builder --
// no spawning, no `napi build`, no cargo, no compiler.
import { describe, expect, it } from "vitest";
import { buildNapiBuildInvocation, resolveNapiCliBin } from "../scripts/lib/napi-invocation.mjs";

function fakeRequireFor(binField: string | Record<string, string>) {
  const pkgPath = "/fake/node_modules/@napi-rs/cli/package.json";
  const requireFn = ((id: string) => {
    if (id === pkgPath) {
      return { bin: binField };
    }
    throw new Error(`unexpected require(${id})`);
  }) as unknown as NodeJS.Require;
  requireFn.resolve = (() => pkgPath) as unknown as NodeJS.RequireResolve;
  return requireFn;
}

describe("resolveNapiCliBin", () => {
  it("joins the package directory with bin.napi when bin is an object", () => {
    const bin = resolveNapiCliBin(fakeRequireFor({ napi: "./dist/cli.js" }));
    expect(bin).toBe("/fake/node_modules/@napi-rs/cli/dist/cli.js");
  });

  it("joins the package directory with bin when bin is a bare string", () => {
    const bin = resolveNapiCliBin(fakeRequireFor("./bin/napi.js"));
    expect(bin).toBe("/fake/node_modules/@napi-rs/cli/bin/napi.js");
  });

  it("throws a clear error when the package declares no napi bin", () => {
    expect(() => resolveNapiCliBin(fakeRequireFor({ other: "./x.js" }))).toThrow(
      /no "bin.napi" entry/,
    );
  });

  it("resolves the real installed @napi-rs/cli package", () => {
    // No injected requireFn -- exercises the real createRequire(import.meta.url) default, so a
    // change to the package's own bin field (or its absence) is caught here too.
    const bin = resolveNapiCliBin();
    expect(bin).toMatch(/cli\.js$/);
  });
});

describe("buildNapiBuildInvocation", () => {
  const requireFn = fakeRequireFor({ napi: "./dist/cli.js" });

  it("never sets shell:true, on any platform", () => {
    const { options } = buildNapiBuildInvocation({
      nativeDir: "/repo/packages/native",
      targetDir: "/repo/packages/native/target",
      stageDir: "/repo/packages/native/target/napi-stage",
      extraArgs: [],
      requireFn,
    });
    expect(options.shell).toBe(false);
  });

  it("spawns process.execPath directly on the resolved cli.js, not a shell string", () => {
    const { command, args } = buildNapiBuildInvocation({
      nativeDir: "/repo/packages/native",
      targetDir: "/repo/packages/native/target",
      stageDir: "/repo/packages/native/target/napi-stage",
      extraArgs: [],
      requireFn,
    });
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe("/fake/node_modules/@napi-rs/cli/dist/cli.js");
    expect(args[1]).toBe("build");
  });

  it("keeps a space-containing stageDir as ONE argv element (the shell-quoting bug this replaces)", () => {
    const nativeDir = "/Users/Jane Doe/repo/packages/native";
    const targetDir = `${nativeDir}/target`;
    const stageDir = `${nativeDir}/target/napi-stage`;
    const { args } = buildNapiBuildInvocation({
      nativeDir,
      targetDir,
      stageDir,
      extraArgs: [],
      requireFn,
    });
    const outputDirIndex = args.indexOf("--output-dir");
    expect(outputDirIndex).toBeGreaterThan(-1);
    // Exactly one argv slot for the whole path, spaces included -- `shell: true` with an args
    // array space-joins unquoted, which would split "Jane Doe" into two argv-equivalent tokens.
    expect(args[outputDirIndex + 1]).toBe(stageDir);
    expect(args[outputDirIndex + 1].includes(" ")).toBe(true);
  });

  it("forwards extraArgs verbatim after the fixed flags (ci-native.yml's --target passthrough)", () => {
    const { args } = buildNapiBuildInvocation({
      nativeDir: "/repo/packages/native",
      targetDir: "/repo/packages/native/target",
      stageDir: "/repo/packages/native/target/napi-stage",
      extraArgs: ["--target", "aarch64-unknown-linux-gnu", "-x"],
      requireFn,
    });
    expect(args.slice(-3)).toEqual(["--target", "aarch64-unknown-linux-gnu", "-x"]);
  });
});
