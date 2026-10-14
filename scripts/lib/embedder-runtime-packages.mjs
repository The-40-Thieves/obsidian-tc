import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ORT_PLATFORMS, ortWasmFiles } from "./embedder-bundle.mjs";

const BASE_PACKAGE = "@the-40-thieves/obsidian-tc-embedder-local";
const REPOSITORY = {
  type: "git",
  url: "git+https://github.com/The-40-Thieves/obsidian-tc.git",
  directory: "packages/embedder-local",
};

export const RUNTIME_PACKAGE_PLATFORMS = {
  ...ORT_PLATFORMS,
  "win32-arm64": {
    backend: "native",
    dir: "win32/arm64",
    files: ["onnxruntime_binding.node", "onnxruntime.dll"],
  },
};

export function runtimePackageName(key) {
  return `${BASE_PACKAGE}-${key}`;
}

export function runtimePackageFiles(ortNodeDir, ortWebDir, key) {
  const spec = RUNTIME_PACKAGE_PLATFORMS[key];
  if (!spec) throw new Error(`embedder-runtime-packages: no ONNX runtime for ${key}`);
  if (spec.backend === "wasm") return ortWasmFiles(ortWebDir);
  return spec.files.map((name) => ({
    name,
    path: join(ortNodeDir, "bin", "napi-v6", ...spec.dir.split("/"), name),
  }));
}

export function runtimePackageManifest(key, version) {
  const spec = RUNTIME_PACKAGE_PLATFORMS[key];
  if (!spec) throw new Error(`embedder-runtime-packages: no ONNX runtime for ${key}`);
  const [platform, arch] = key.split("-");
  const runtimeFiles =
    spec.backend === "wasm" ? ortWasmFiles(".").map((file) => file.name) : [...spec.files];
  return {
    name: runtimePackageName(key),
    version,
    description: `ONNX Runtime for ${BASE_PACKAGE} on ${key}`,
    license: "MIT",
    os: [platform],
    cpu: [arch],
    ...(platform === "linux" ? { libc: ["glibc"] } : {}),
    files: [...runtimeFiles, "LICENSE"],
    publishConfig: { access: "public" },
    repository: REPOSITORY,
  };
}

export function basePackageManifest(version, keys) {
  return {
    name: BASE_PACKAGE,
    version,
    description:
      "Optional bundled dense embedder for obsidian-tc — runs fully offline and installs only the host ONNX runtime",
    license: "AGPL-3.0-only",
    type: "module",
    main: "./index.mjs",
    exports: {
      ".": "./index.mjs",
      "./package.json": "./package.json",
      "./runtime-pins.json": "./runtime-pins.json",
    },
    files: ["index.mjs", "embedder.mjs", "runtime-pins.json", "README.md", "LICENSE"],
    engines: { node: ">=24" },
    publishConfig: { access: "public" },
    repository: REPOSITORY,
    optionalDependencies: Object.fromEntries(keys.map((key) => [runtimePackageName(key), version])),
  };
}

export function runtimePins(version, filesByKey) {
  return {
    version,
    packages: Object.fromEntries(
      Object.entries(filesByKey).map(([key, files]) => [
        key,
        {
          name: runtimePackageName(key),
          files: files.map((file) => {
            const bytes = readFileSync(file.path);
            return {
              name: file.name,
              size: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
          }),
        },
      ]),
    ),
  };
}

function freshDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function assembleRuntimePackage(outDir, key, version, files, licenseFile) {
  const dir = freshDir(join(outDir, key));
  writeJson(join(dir, "package.json"), runtimePackageManifest(key, version));
  for (const file of files) copyFileSync(file.path, join(dir, file.name));
  copyFileSync(licenseFile, join(dir, "LICENSE"));
  return dir;
}

export function assembleBasePackage(
  outDir,
  { version, entryFile, bundleFile, pins, readme, license },
) {
  const dir = freshDir(join(outDir, "base"));
  copyFileSync(entryFile, join(dir, "index.mjs"));
  copyFileSync(bundleFile, join(dir, "embedder.mjs"));
  copyFileSync(readme, join(dir, "README.md"));
  copyFileSync(license, join(dir, "LICENSE"));
  writeJson(join(dir, "runtime-pins.json"), pins);
  writeJson(join(dir, "package.json"), basePackageManifest(version, Object.keys(pins.packages)));
  return dir;
}

const RUNTIME_BINARY = /(?:\.node|\.so(?:\..*)?|\.dylib|\.dll|\.wasm)$/i;

export function assertNoRuntimeBinaries(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) assertNoRuntimeBinaries(path);
    else if (RUNTIME_BINARY.test(entry.name)) {
      throw new Error(
        `embedder-runtime-packages: base package contains runtime binary ${basename(path)}`,
      );
    }
  }
}
