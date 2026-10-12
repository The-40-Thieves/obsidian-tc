import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as embedderBundle from "./lib/embedder-bundle.mjs";
import {
  BUN_TARGET_ORT_PLATFORM,
  embedderBundlePlugin,
  ORT_PLATFORMS,
  ortNativeFiles,
  ortWasmFiles,
  patchOrtBindingSource,
  patchTransformersSource,
  SHARP_STUB,
} from "./lib/embedder-bundle.mjs";

const ORT_RUNTIME_SHIM = embedderBundle.ORT_RUNTIME_SHIM;
const ortRuntimeFiles = embedderBundle.ortRuntimeFiles;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORT_REQUIRE = 'var onnx_node_default = requireFromHere("onnxruntime-node");';
const BINDING_REQUIRE = `require(\`../bin/napi-v6/\${process.platform}/\${process.arch}/onnxruntime_binding.node\`)`;

test("patchTransformersSource turns the runtime onnxruntime-node require into a static import", () => {
  const out = patchTransformersSource(`a;\n${ORT_REQUIRE}\nb;`);
  assert.ok(!out.includes("requireFromHere("), "the runtime require is gone");
  assert.match(out, /import __obtcOrtNode from "onnxruntime-node";/);
  assert.match(out, /var onnx_node_default = __obtcOrtNode;/);
});

test("patchOrtBindingSource routes the native-addon require through the binding loader", () => {
  const out = patchOrtBindingSource(`exports.binding = ${BINDING_REQUIRE};`);
  assert.equal(out, 'exports.binding = require("obtc-ort-binding").loadOrtBinding();');
});

// The pinned dependencies can change shape under a version bump; a rewrite that silently matched
// nothing would ship a bundle whose embedder cannot load. Both directions must throw.
test("each rewrite throws when its target text is missing or appears twice", () => {
  assert.throws(() => patchTransformersSource("var x = 1;"), /exactly one occurrence/);
  assert.throws(() => patchTransformersSource(`${ORT_REQUIRE}\n${ORT_REQUIRE}`), /exactly one/);
  assert.throws(
    () => patchOrtBindingSource("exports.binding = require('./x.node');"),
    /exactly one/,
  );
  assert.throws(() => patchOrtBindingSource(`${BINDING_REQUIRE}${BINDING_REQUIRE}`), /exactly one/);
});

test("the sharp stub has a default export that fails loudly if it is ever called", () => {
  assert.match(SHARP_STUB, /export default function sharp\(\)/);
  assert.match(SHARP_STUB, /throw new Error/);
});

test("every bun compile target with an onnxruntime build maps to a known platform", () => {
  assert.ok(Object.keys(BUN_TARGET_ORT_PLATFORM).length >= 5, "all 5 targets embed a runtime");
  for (const platform of Object.values(BUN_TARGET_ORT_PLATFORM)) {
    assert.ok(ORT_PLATFORMS[platform], `${platform} has a file list`);
  }
  assert.equal(BUN_TARGET_ORT_PLATFORM["bun-darwin-x64"], "darwin-x64");
  assert.equal(ORT_PLATFORMS["darwin-x64"].backend, "wasm");
});

test("ortNativeFiles lays the binding and its library out under bin/napi-v6/<os>/<arch>", () => {
  const files = ortNativeFiles("/ort", "linux-x64");
  assert.deepEqual(
    files.map((f) => f.name),
    ["onnxruntime_binding.node", "libonnxruntime.so.1"],
  );
  assert.equal(
    files[0].path,
    join("/ort", "bin", "napi-v6", "linux", "x64", "onnxruntime_binding.node"),
  );
  assert.throws(() => ortNativeFiles("/ort", "darwin-x64"), /no onnxruntime-node build/);
});

test("ortRuntimeFiles embeds the two WASM assets for bun-darwin-x64", () => {
  assert.equal(typeof ortRuntimeFiles, "function");
  assert.deepEqual(
    ortRuntimeFiles("/node", "/web", "darwin-x64").map((f) => f.name),
    ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"],
  );
});

test("the plugin registers resolvers and loaders, and hands the builder to `extra`", () => {
  const calls = { resolve: [], load: [] };
  let extraSaw;
  const plugin = embedderBundlePlugin((b) => {
    extraSaw = b;
  });
  const builder = {
    onResolve: (opts, callback) => calls.resolve.push({ filter: opts.filter, callback }),
    onLoad: (opts) => calls.load.push(opts.filter.source),
  };
  plugin.setup(builder);
  assert.equal(extraSaw, builder);
  assert.ok(calls.resolve.some(({ filter }) => filter.source === "^sharp$"));
  assert.ok(calls.resolve.some(({ filter }) => filter.source.includes("obtc-ort-binding")));
  const resolve = (path) => {
    const match = calls.resolve.find(({ filter }) => filter.test(path));
    assert.ok(match, `no resolver registered for ${path}`);
    return match.callback({ path, importer: transformersFile });
  };
  assert.equal(resolve("onnxruntime-node").path, ORT_RUNTIME_SHIM);
  assert.equal(resolve("onnxruntime-web").path, ORT_RUNTIME_SHIM);
  assert.equal(calls.load.length, 3, "sharp stub + transformers + onnxruntime-node binding");
});

test("the runtime selector uses native ORT except for darwin-x64, where it configures web WASM", async () => {
  const selectorFile = join(ROOT, "scripts", "lib", "ort-runtime-selection.mjs");
  assert.ok(existsSync(selectorFile), `${selectorFile} exists`);
  const { selectOrtRuntime } = await import(selectorFile);
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
  ]) {
    const native = { kind: `${platform}-${arch}-native` };
    assert.equal(
      selectOrtRuntime({
        platform,
        arch,
        loadNative: () => native,
        loadWeb: () => assert.fail("web must not load"),
      }),
      native,
    );
  }
  const web = { env: { wasm: {} } };
  const logs = [];
  assert.equal(
    selectOrtRuntime({
      platform: "darwin",
      arch: "x64",
      runtimeDir: "/runtime",
      loadNative: () => assert.fail("native must not load"),
      loadWeb: () => web,
      readFile: () => Buffer.from("wasm"),
      log: (message) => logs.push(message),
    }),
    web,
  );
  assert.equal(web.env.wasm.wasmPaths.mjs, "file:///runtime/ort-wasm-simd-threaded.mjs");
  assert.equal(web.env.wasm.wasmPaths.wasm, "file:///runtime/ort-wasm-simd-threaded.wasm");
  assert.equal(Buffer.from(web.env.wasm.wasmBinary).toString(), "wasm");
  assert.match(logs[0], /local embedder runs on onnxruntime-web \(WASM\) instead/);
  selectOrtRuntime({
    platform: "darwin",
    arch: "x64",
    runtimeDir: "/runtime",
    loadNative: () => assert.fail("native must not load"),
    loadWeb: () => web,
    readFile: () => Buffer.from("wasm"),
    log: (message) => logs.push(message),
  });
  assert.equal(logs.length, 1, "the WASM fallback notice is emitted once per process");
});

// Against the REAL pinned files, when packages/embedder-local is installed (CI's lint job is not,
// the matrix and release jobs are): the strongest guard that a dependency bump did not move them.
const embedderModules = join(ROOT, "packages", "embedder-local", "node_modules");
const transformersFile = join(
  embedderModules,
  "@huggingface",
  "transformers",
  "dist",
  "transformers.node.mjs",
);
const bindingFile = join(embedderModules, "onnxruntime-node", "dist", "binding.js");
const installed = existsSync(transformersFile) && existsSync(bindingFile);

test("the rewrites apply to the installed transformers.js and onnxruntime-node", {
  skip: !installed,
}, () => {
  assert.doesNotThrow(() => patchTransformersSource(readFileSync(transformersFile, "utf8")));
  assert.doesNotThrow(() => patchOrtBindingSource(readFileSync(bindingFile, "utf8")));
  for (const [platform, spec] of Object.entries(ORT_PLATFORMS)) {
    if (spec.backend !== "native") continue;
    for (const f of ortNativeFiles(join(embedderModules, "onnxruntime-node"), platform)) {
      assert.ok(existsSync(f.path), `${f.path} exists in the installed onnxruntime-node`);
    }
  }
});

const realBundleHost = `${process.platform}-${process.arch}`;
const realBundleHostSupported = ORT_PLATFORMS[realBundleHost]?.backend === "native";

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

// Round 1 passed selection-seam tests but failed only after Bun had emitted a real artifact. The
// incidents this regression must retain verbatim were:
//   FAIL: Cannot find module 'obtc-ort-native'
//   FAIL: Cannot find module 'obtc-ort-web'
//   FAIL: Unsupported device: "cpu". Should be one of: .
test("a real bundled embedder imports with a populated Transformers device set on native and darwin-x64 WASM", {
  skip: !installed || !realBundleHostSupported,
}, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "obtc-real-embedder-bundle-"));
  try {
    const entry = join(work, "entry.mjs");
    const builder = join(work, "build.mjs");
    const runner = join(work, "run.mjs");
    const bundle = join(work, "embedder.mjs");
    const probeBundle = join(work, "probe.mjs");
    const embedderEntry = join(ROOT, "packages", "embedder-local", "dist", "index.js");
    const missingModel = join(work, "no-model-weights");

    writeFileSync(
      entry,
      `import { BertModel, env as transformersEnv } from ${JSON.stringify(transformersFile)};
import ort from "onnxruntime-node";
export * from ${JSON.stringify(embedderEntry)};

export async function inspectBundledOrt() {
  let modelFailure = "";
  try {
    await BertModel.from_pretrained(${JSON.stringify(missingModel)}, {
      config: { model_type: "bert" },
      local_files_only: true,
      device: "cpu",
      dtype: "fp32",
    });
  } catch (error) {
    modelFailure = error instanceof Error ? error.message : String(error);
  }
  if (!modelFailure) throw new Error("the weight-free device probe unexpectedly loaded a model");
  return {
    modelFailure,
    backendKeys: Object.keys(transformersEnv.backends.onnx ?? {}),
    versions: ort.env.versions,
    wasmPaths: ort.env.wasm?.wasmPaths,
    wasmBinaryBytes: ort.env.wasm?.wasmBinary?.byteLength ?? 0,
  };
}
`,
    );
    writeFileSync(
      builder,
      `import { embedderBundlePlugin } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts", "lib", "embedder-bundle.mjs")).href)};
for (const [entrypoint, naming] of [
  [${JSON.stringify(embedderEntry)}, "embedder.mjs"],
  [${JSON.stringify(entry)}, "probe.mjs"],
]) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: ${JSON.stringify(work)},
    naming,
    target: "node",
    format: "esm",
    plugins: [embedderBundlePlugin()],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    process.exit(1);
  }
}
`,
    );
    writeFileSync(
      runner,
      `if (process.argv[3] === "darwin-x64") {
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.defineProperty(process, "arch", { value: "x64" });
}
const bundled = await import(process.argv[2]);
const runtime = process.argv[4] === "import-only" ? undefined : await bundled.inspectBundledOrt();
console.log(JSON.stringify({ runtime, exports: Object.keys(bundled) }));
`,
    );

    runOrThrow("bun", [builder]);
    const nativeDir = join(work, "ort", realBundleHost);
    mkdirSync(nativeDir, { recursive: true });
    for (const file of ortNativeFiles(join(embedderModules, "onnxruntime-node"), realBundleHost)) {
      copyFileSync(file.path, join(nativeDir, file.name));
    }
    for (const file of ortWasmFiles(join(embedderModules, "onnxruntime-web"))) {
      copyFileSync(file.path, join(work, file.name));
    }

    await t.test("contains no private ORT runtime lookup", () => {
      for (const file of [bundle, probeBundle]) {
        const output = readFileSync(file, "utf8");
        assert.doesNotMatch(output, /require\(["']obtc-ort-/);
        assert.doesNotMatch(output, /createRequire[^\n;]*obtc-ort-/);
        assert.ok(
          !output.includes("obtc-ort-native"),
          `${file}: native private specifier was bundled away`,
        );
        assert.ok(
          !output.includes("obtc-ort-web"),
          `${file}: web private specifier was bundled away`,
        );
      }
    });

    await t.test("imports the exact bundle-mcpb entrypoint under Node without weights", () => {
      for (const platform of [undefined, "darwin-x64"]) {
        const args = [runner, pathToFileURL(bundle).href];
        if (platform) args.push(platform);
        else args.push("host");
        args.push("import-only");
        const result = runOrThrow(process.execPath, args);
        const imported = JSON.parse(result.stdout.trim());
        assert.ok(imported.exports.includes("createEmbeddingProvider"));
      }
    });

    await t.test(`imports under Node on ${realBundleHost} with cpu supported`, () => {
      const result = runOrThrow(process.execPath, [runner, pathToFileURL(probeBundle).href]);
      const probe = JSON.parse(result.stdout.trim());
      assert.ok(probe.exports.includes("createEmbeddingProvider"));
      assert.doesNotMatch(probe.runtime.modelFailure, /Unsupported device/);
      assert.ok(probe.runtime.backendKeys.length > 0, "Transformers registered its ONNX backend");
      assert.ok(probe.runtime.versions.node, "the host path selected onnxruntime-node");
    });

    await t.test("imports under Node on simulated darwin-x64 with file-backed WASM", () => {
      const result = runOrThrow(process.execPath, [
        runner,
        pathToFileURL(probeBundle).href,
        "darwin-x64",
      ]);
      const probe = JSON.parse(result.stdout.trim());
      assert.doesNotMatch(probe.runtime.modelFailure, /Unsupported device/);
      assert.ok(probe.runtime.backendKeys.length > 0, "Transformers registered its ONNX backend");
      assert.ok(probe.runtime.versions.web, "the darwin-x64 path selected onnxruntime-web");
      assert.match(probe.runtime.wasmPaths.mjs, /^file:.*ort-wasm-simd-threaded\.mjs$/);
      assert.match(probe.runtime.wasmPaths.wasm, /^file:.*ort-wasm-simd-threaded\.wasm$/);
      assert.ok(probe.runtime.wasmBinaryBytes > 0, "the WASM binary bytes were supplied directly");
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
