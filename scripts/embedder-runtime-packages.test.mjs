import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  assembleBasePackage,
  assembleRuntimePackage,
  assertNoRuntimeBinaries,
  basePackageManifest,
  RUNTIME_PACKAGE_PLATFORMS,
  runtimePackageFiles,
  runtimePackageManifest,
  runtimePackageName,
  runtimePins,
} from "./lib/embedder-runtime-packages.mjs";

const KEYS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"];
const VERSION = "1.2.3";
const tempDirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function fixtureTree() {
  const root = tempDir("obtc-runtime-packages-");
  const ortNode = join(root, "onnxruntime-node");
  const ortWeb = join(root, "onnxruntime-web");
  for (const [key, spec] of Object.entries(RUNTIME_PACKAGE_PLATFORMS)) {
    if (spec.backend !== "native") continue;
    const dir = join(ortNode, "bin", "napi-v6", ...spec.dir.split("/"));
    mkdirSync(dir, { recursive: true });
    for (const name of spec.files) writeFileSync(join(dir, name), `${key}:${name}`);
  }
  const webDist = join(ortWeb, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "ort-wasm-simd-threaded.mjs"), "wasm-loader");
  writeFileSync(join(webDist, "ort-wasm-simd-threaded.wasm"), "wasm-binary");
  return { root, ortNode, ortWeb };
}

test("the runtime package matrix has the six supported npm platform keys", () => {
  assert.deepEqual(Object.keys(RUNTIME_PACKAGE_PLATFORMS), KEYS);
  assert.deepEqual(RUNTIME_PACKAGE_PLATFORMS["win32-arm64"], {
    backend: "native",
    dir: "win32/arm64",
    files: ["onnxruntime_binding.node", "onnxruntime.dll"],
  });
});

test("runtime package names and manifests carry exact npm platform filters", () => {
  for (const key of KEYS) {
    const [platform, arch] = key.split("-");
    assert.equal(runtimePackageName(key), `@the-40-thieves/obsidian-tc-embedder-local-${key}`);
    const manifest = runtimePackageManifest(key, VERSION);
    assert.equal(manifest.name, runtimePackageName(key));
    assert.equal(manifest.version, VERSION);
    assert.deepEqual(manifest.os, [platform]);
    assert.deepEqual(manifest.cpu, [arch]);
    assert.deepEqual(manifest.files.at(-1), "LICENSE");
    assert.equal("exports" in manifest, false);
    assert.equal("scripts" in manifest, false);
    if (platform === "linux") assert.deepEqual(manifest.libc, ["glibc"]);
    else assert.equal("libc" in manifest, false);
  }
});

test("the base manifest has no dependencies and exact-pins every runtime package", () => {
  const manifest = basePackageManifest(VERSION, KEYS);
  assert.equal(manifest.license, "AGPL-3.0-only");
  assert.equal("dependencies" in manifest, false);
  assert.deepEqual(
    manifest.optionalDependencies,
    Object.fromEntries(KEYS.map((key) => [runtimePackageName(key), VERSION])),
  );
  assert.deepEqual(manifest.exports, {
    ".": "./index.mjs",
    "./package.json": "./package.json",
    "./runtime-pins.json": "./runtime-pins.json",
  });
});

test("runtimePackageFiles selects native files and the darwin-x64 WASM pair", () => {
  const { ortNode, ortWeb } = fixtureTree();
  assert.deepEqual(
    runtimePackageFiles(ortNode, ortWeb, "linux-x64").map((file) => file.name),
    ["onnxruntime_binding.node", "libonnxruntime.so.1"],
  );
  assert.deepEqual(
    runtimePackageFiles(ortNode, ortWeb, "darwin-x64").map((file) => file.name),
    ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"],
  );
});

test("runtimePins records each fixture file's byte size and sha256", () => {
  const root = tempDir("obtc-runtime-pins-");
  const a = join(root, "a.node");
  const b = join(root, "b.so.1");
  writeFileSync(a, "abc");
  writeFileSync(b, "hello");
  assert.deepEqual(
    runtimePins(VERSION, {
      "linux-x64": [
        { name: "a.node", path: a },
        { name: "b.so.1", path: b },
      ],
    }),
    {
      version: VERSION,
      packages: {
        "linux-x64": {
          name: runtimePackageName("linux-x64"),
          files: [
            {
              name: "a.node",
              size: 3,
              sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            },
            {
              name: "b.so.1",
              size: 5,
              sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            },
          ],
        },
      },
    },
  );
});

test("assembly writes base and runtime package layouts", () => {
  const root = tempDir("obtc-runtime-assembly-");
  const fixtures = join(root, "fixtures");
  mkdirSync(fixtures);
  const entry = join(fixtures, "entry.mjs");
  const bundle = join(fixtures, "bundle.mjs");
  const readme = join(fixtures, "README.md");
  const baseLicense = join(fixtures, "BASE-LICENSE");
  const runtimeLicense = join(fixtures, "RUNTIME-LICENSE");
  const runtimeFile = join(fixtures, "onnxruntime_binding.node");
  writeFileSync(entry, "export const entry = true;\n");
  writeFileSync(bundle, "export const bundle = true;\n");
  writeFileSync(readme, "readme\n");
  writeFileSync(baseLicense, "AGPL\n");
  writeFileSync(runtimeLicense, "MIT\n");
  writeFileSync(runtimeFile, "native\n");
  const pins = runtimePins(VERSION, {
    "linux-x64": [{ name: "onnxruntime_binding.node", path: runtimeFile }],
  });

  const base = assembleBasePackage(root, {
    version: VERSION,
    entryFile: entry,
    bundleFile: bundle,
    pins,
    readme,
    license: baseLicense,
  });
  const runtime = assembleRuntimePackage(
    root,
    "linux-x64",
    VERSION,
    [{ name: "onnxruntime_binding.node", path: runtimeFile }],
    runtimeLicense,
  );

  assert.equal(base, join(root, "base"));
  assert.equal(runtime, join(root, "linux-x64"));
  assert.deepEqual(
    ["LICENSE", "README.md", "embedder.mjs", "index.mjs", "package.json", "runtime-pins.json"],
    [
      "LICENSE",
      "README.md",
      "embedder.mjs",
      "index.mjs",
      "package.json",
      "runtime-pins.json",
    ].filter((name) => readFileSync(join(base, name))),
  );
  assert.equal(
    JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")).name,
    runtimePackageName("linux-x64"),
  );
  assert.equal(readFileSync(join(runtime, "onnxruntime_binding.node"), "utf8"), "native\n");
});

test("assertNoRuntimeBinaries rejects a base package containing WASM", () => {
  const root = tempDir("obtc-runtime-binary-check-");
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "runtime.wasm"), "bad");
  assert.throws(() => assertNoRuntimeBinaries(root), /runtime\.wasm/);
});
