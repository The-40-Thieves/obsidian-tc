// Compile the standalone binary: `bun scripts/build-binary.ts --target <bun-target> --outfile <path>`.
//
// The one place that knows how the binary is built, shared by publish.yml's build-binaries and
// ci-first-run-smoke.yml so the binary the matrix measures is the binary users get. It is
// `bun build packages/server/src/cli.ts --compile --bytecode --minify --sourcemap` plus what the CLI
// cannot express: a plugin that makes the local embedder (the default embeddings provider) work
// inside the executable.
//
// `bun build --compile` embeds no assets and freezes import.meta.url, so an optional package cannot
// be found at run time. This script bundles packages/embedder-local, Transformers.js, and the ONNX
// runtime shim into the executable, then embeds the target's native ORT files or darwin-x64 WASM
// files, gzipped. packages/server/src/providers/local-embedder-registry.ts unpacks them on first use.
// Prerequisites: packages/embedder-local installed and built (`bun install --frozen-lockfile && bun
// run build` there); sqlite-vec / SQLite are embedded by their own earlier steps.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  generateEmbeddedEmbedderModule,
  prepareEmbeddedRuntimeFiles,
} from "./lib/embedded-embedder-module.mjs";
import {
  BUN_TARGET_ORT_PLATFORM,
  embedderBundlePlugin,
  ortRuntimeFiles,
} from "./lib/embedder-bundle.mjs";

const repoRoot = resolve(import.meta.dir, "..");
const server = join(repoRoot, "packages", "server");
const embedder = join(repoRoot, "packages", "embedder-local");
const EMBEDDER_PACKAGE = "@the-40-thieves/obsidian-tc-embedder-local";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (!v) throw new Error(`build-binary: --${name} <value> is required`);
  return v;
}

const target = arg("target");
const outfile = resolve(arg("outfile"));
const ortPlatform = BUN_TARGET_ORT_PLATFORM[target as keyof typeof BUN_TARGET_ORT_PLATFORM];

const external = ["@the-40-thieves/obsidian-tc-reranker-local"];
const work = mkdtempSync(join(tmpdir(), "obtc-binary-"));
try {
  let plugins: Bun.BunPlugin[] = [];
  if (ortPlatform) {
    const embedderEntry = join(embedder, "dist", "index.js");
    const ortNodeDir = join(embedder, "node_modules", "onnxruntime-node");
    const ortWebDir = join(embedder, "node_modules", "onnxruntime-web");
    const runtimeFiles = ortRuntimeFiles(ortNodeDir, ortWebDir, ortPlatform);
    for (const need of [embedderEntry, ...runtimeFiles.map((f) => f.path)]) {
      if (!existsSync(need)) {
        throw new Error(
          `build-binary: ${need} is missing; run \`bun install --frozen-lockfile && bun run build\` in packages/embedder-local first`,
        );
      }
    }
    const files = prepareEmbeddedRuntimeFiles(runtimeFiles, work);
    // The module that replaces embeddings/embedded-embedder.ts for this build (see its header).
    const generated = generateEmbeddedEmbedderModule(files, EMBEDDER_PACKAGE);
    const placeholder = join(server, "src", "embeddings", "embedded-embedder.ts");
    plugins = [
      embedderBundlePlugin((build: Bun.PluginBuilder) => {
        build.onResolve({ filter: /^@the-40-thieves\/obsidian-tc-embedder-local$/ }, () => ({
          path: embedderEntry,
        }));
        build.onLoad({ filter: /embeddings[\\/]embedded-embedder\.ts$/ }, ({ path }) => {
          if (resolve(path) !== placeholder) return undefined;
          return { contents: generated, loader: "js" };
        });
      }),
    ];
  } else {
    external.push(EMBEDDER_PACKAGE);
    // Keep an explicit absent module for a future Bun target that has neither native nor WASM ORT.
    const absentPlaceholder = join(server, "src", "embeddings", "embedded-embedder.ts");
    plugins = [
      embedderBundlePlugin((build: Bun.PluginBuilder) => {
        build.onLoad({ filter: /embeddings[\\/]embedded-embedder\.ts$/ }, ({ path }) => {
          if (resolve(path) !== absentPlaceholder) return undefined;
          return {
            contents:
              "export const embeddedEmbedder = undefined;\nexport const localEmbedderAbsentFromBinary = true;\n",
            loader: "js",
          };
        });
      }),
    ];
    console.warn(
      `build-binary: no bundled ONNX runtime is configured for ${target}; the binary has no local embedder`,
    );
  }

  mkdirSync(resolve(outfile, ".."), { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(server, "src", "cli.ts")],
    compile: { target: target as Bun.Build.CompileTarget, outfile },
    bytecode: true,
    format: "esm",
    minify: true,
    sourcemap: "inline",
    external,
    plugins,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error("build-binary: bun build failed");
  }
  console.log(`build-binary: wrote ${outfile}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
