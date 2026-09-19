// Unit tests for scripts/build.mjs's runBuild() (THE-1080, #948) -- the orchestration that ties
// together napi-invocation, artifact-copy and stage-dir. Real temp dirs on disk (mkdtempSync);
// `spawnFn` is always faked (never runs a real `napi build`), and `fsImpl` is real fs functions
// with a targeted override per test. Asserts the one property review round 3 found missing: the
// stage dir is ALWAYS removed, on every failure shape -- not just the ones that used to route
// through process.exit.
import type { spawnSync } from "node:child_process";
import * as realFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBuild } from "../scripts/build.mjs";

function fakeFsImpl(overrides: Record<string, unknown> = {}) {
  return {
    existsSync: realFs.existsSync,
    readFileSync: realFs.readFileSync,
    copyFileSync: realFs.copyFileSync,
    renameSync: realFs.renameSync,
    unlinkSync: realFs.unlinkSync,
    readdirSync: realFs.readdirSync,
    rmSync: realFs.rmSync,
    ...overrides,
  };
}

// runBuild's default `spawnFn` is Node's real `spawnSync`, so TS infers the parameter's type from
// that default -- a fake only needs the two fields runBuild actually reads (`status`, `error`),
// not spawnSync's full SpawnSyncReturns shape (pid, output, stdout, stderr, signal).
function fakeSpawn(result: { status: number | null; error?: Error }) {
  return (() => result) as unknown as typeof spawnSync;
}

describe("runBuild", () => {
  let root: string;
  let nativeDir: string;
  let targetDir: string;
  let stageDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "run-build-"));
    nativeDir = join(root, "native");
    targetDir = join(nativeDir, "target");
    mkdirSync(targetDir, { recursive: true });
    stageDir = mkdtempSync(join(targetDir, "napi-stage-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes the stage dir and forwards the exit code when napi build exits non-zero", () => {
    const spawnFn = fakeSpawn({ status: 2 });

    const code = runBuild({
      nativeDir,
      targetDir,
      stageDir,
      extraArgs: [],
      spawnFn,
      fsImpl: fakeFsImpl(),
    });

    expect(code).toBe(2);
    expect(existsSync(stageDir)).toBe(false);
  });

  it("removes the stage dir and prints the spawn error when napi build fails to start", () => {
    const errors: string[] = [];
    const spawnFn = fakeSpawn({
      status: null,
      error: new Error("ENOENT: no such file or directory"),
    });

    const code = runBuild({
      nativeDir,
      targetDir,
      stageDir,
      extraArgs: [],
      spawnFn,
      fsImpl: fakeFsImpl(),
      errorLog: (msg: string) => errors.push(msg),
    });

    expect(code).toBe(1);
    expect(errors.some((m) => m.includes("ENOENT"))).toBe(true);
    expect(existsSync(stageDir)).toBe(false);
  });

  it("removes the stage dir when napi build produces no .node file", () => {
    const spawnFn = fakeSpawn({ status: 0 });

    const code = runBuild({
      nativeDir,
      targetDir,
      stageDir,
      extraArgs: [],
      spawnFn,
      fsImpl: fakeFsImpl(),
    });

    expect(code).toBe(1);
    expect(existsSync(stageDir)).toBe(false);
  });

  it("removes the stage dir when the copy hits a typed ArtifactCopyError", () => {
    writeFileSync(join(stageDir, "obsidian-tc-native.linux-x64-gnu.node"), "bytes");
    const spawnFn = fakeSpawn({ status: 0 });
    const lockErr = Object.assign(new Error("busy"), { code: "EBUSY" });

    const code = runBuild({
      nativeDir,
      targetDir,
      stageDir,
      extraArgs: [],
      spawnFn,
      fsImpl: fakeFsImpl({
        renameSync: () => {
          throw lockErr;
        },
      }),
    });

    expect(code).toBe(1);
    expect(existsSync(stageDir)).toBe(false);
  });

  it("removes the stage dir even when an UNEXPECTED (non-lock) error throws", () => {
    writeFileSync(join(stageDir, "obsidian-tc-native.linux-x64-gnu.node"), "bytes");
    const spawnFn = fakeSpawn({ status: 0 });
    const oddErr = Object.assign(new Error("disk full"), { code: "ENOSPC" });

    expect(() =>
      runBuild({
        nativeDir,
        targetDir,
        stageDir,
        extraArgs: [],
        spawnFn,
        fsImpl: fakeFsImpl({
          copyFileSync: () => {
            throw oddErr;
          },
        }),
      }),
    ).toThrow("disk full");
    expect(existsSync(stageDir)).toBe(false);
  });

  it("removes the stage dir when napi-invocation itself throws (e.g. no bin.napi)", () => {
    // Exercises the OTHER unexpected-throw source review round 3 named: a throw that happens
    // before spawnFn is even called (buildNapiBuildInvocation resolving @napi-rs/cli's bin field).
    const spawnFn = (() => {
      throw new Error("spawnFn should never be reached");
    }) as unknown as typeof spawnSync;

    expect(() =>
      runBuild({
        nativeDir,
        targetDir,
        stageDir,
        extraArgs: ["--watch"],
        spawnFn,
        fsImpl: fakeFsImpl(),
      }),
    ).toThrow(/--watch is not supported/);
    expect(existsSync(stageDir)).toBe(false);
  });

  it("promotes on success and still removes the (now empty of artifacts) stage dir", () => {
    writeFileSync(join(stageDir, "obsidian-tc-native.linux-x64-gnu.node"), "bytes");
    const spawnFn = fakeSpawn({ status: 0 });
    const logs: string[] = [];

    const code = runBuild({
      nativeDir,
      targetDir,
      stageDir,
      extraArgs: [],
      spawnFn,
      fsImpl: fakeFsImpl(),
      log: (msg: string) => logs.push(msg),
    });

    expect(code).toBe(0);
    expect(existsSync(stageDir)).toBe(false);
    expect(existsSync(join(nativeDir, "obsidian-tc-native.linux-x64-gnu.node"))).toBe(true);
    expect(logs.some((m) => m.includes("updated"))).toBe(true);
  });
});
