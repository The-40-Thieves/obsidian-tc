import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { embedderBundlePlugin } from "./lib/embedder-bundle.mjs";
import {
  assembleBasePackage,
  assembleRuntimePackage,
  assertNoRuntimeBinaries,
  RUNTIME_PACKAGE_PLATFORMS,
  runtimePackageFiles,
  runtimePins,
} from "./lib/embedder-runtime-packages.mjs";

const repoRoot = resolve(import.meta.dir, "..");
const embedderDir = join(repoRoot, "packages", "embedder-local");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`pack-embedder-local: --${name} requires a value`);
  }
  return value;
}

function directorySize(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const path = join(dir, entry.name);
    return sum + (entry.isDirectory() ? directorySize(path) : statSync(path).size);
  }, 0);
}

const packageManifest = JSON.parse(readFileSync(join(embedderDir, "package.json"), "utf8")) as {
  version: string;
};
const version = option("version") ?? packageManifest.version;
const outDir = resolve(option("out") ?? join(repoRoot, "dist", "embedder-local-npm"));
const entryFile = join(embedderDir, "dist", "index.js");
const ortNodeDir = join(embedderDir, "node_modules", "onnxruntime-node");
const ortWebDir = join(embedderDir, "node_modules", "onnxruntime-web");
const runtimeFiles = Object.fromEntries(
  Object.keys(RUNTIME_PACKAGE_PLATFORMS).map((key) => [
    key,
    runtimePackageFiles(ortNodeDir, ortWebDir, key),
  ]),
);
// onnxruntime-node and onnxruntime-web declare MIT but ship no LICENSE file, so the text is vendored.
const runtimeLicense = join(embedderDir, "licenses", "onnxruntime-LICENSE");
const required = [
  entryFile,
  runtimeLicense,
  ...Object.values(runtimeFiles).flatMap((files) => files.map((file) => file.path)),
];
for (const path of required) {
  if (!existsSync(path)) {
    throw new Error(
      `pack-embedder-local: ${path} is missing; run \`bun install --frozen-lockfile && bun run build\` in packages/embedder-local first`,
    );
  }
}

mkdirSync(outDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "obtc-embedder-npm-"));
try {
  const bundled = await Bun.build({
    entrypoints: [entryFile],
    outdir: scratch,
    naming: "embedder.mjs",
    target: "node",
    format: "esm",
    minify: true,
    plugins: [embedderBundlePlugin()],
  });
  if (!bundled.success) {
    for (const log of bundled.logs) console.error(String(log));
    throw new Error("pack-embedder-local: bundling the local embedder failed");
  }

  const pins = runtimePins(version, runtimeFiles);
  for (const [key, files] of Object.entries(runtimeFiles)) {
    assembleRuntimePackage(outDir, key, version, files, runtimeLicense);
  }
  const baseDir = assembleBasePackage(outDir, {
    version,
    entryFile: join(repoRoot, "scripts", "lib", "embedder-package-entry.mjs"),
    bundleFile: join(scratch, "embedder.mjs"),
    pins,
    readme: join(embedderDir, "README.md"),
    license: join(embedderDir, "LICENSE"),
  });
  assertNoRuntimeBinaries(baseDir);

  for (const name of [...Object.keys(RUNTIME_PACKAGE_PLATFORMS), "base"]) {
    const dir = join(outDir, name);
    console.log(`pack-embedder-local: ${dir} ${directorySize(dir)} bytes`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
