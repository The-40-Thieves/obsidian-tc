import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUN_TARGET_ORT_PLATFORM,
  embedderBundlePlugin,
  ORT_PLATFORMS,
  ortNativeFiles,
  patchOrtBindingSource,
  patchTransformersSource,
  SHARP_STUB,
} from "./lib/embedder-bundle.mjs";

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
  assert.ok(Object.keys(BUN_TARGET_ORT_PLATFORM).length >= 4, "floor: 4 targets embed the runtime");
  for (const platform of Object.values(BUN_TARGET_ORT_PLATFORM)) {
    assert.ok(ORT_PLATFORMS[platform], `${platform} has a file list`);
  }
  // darwin-x64 has no onnxruntime-node build, so it must NOT claim one.
  assert.equal(BUN_TARGET_ORT_PLATFORM["bun-darwin-x64"], undefined);
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

test("the plugin registers resolvers and loaders, and hands the builder to `extra`", () => {
  const calls = { resolve: [], load: [] };
  let extraSaw;
  const plugin = embedderBundlePlugin((b) => {
    extraSaw = b;
  });
  const builder = {
    onResolve: (opts) => calls.resolve.push(opts.filter.source),
    onLoad: (opts) => calls.load.push(opts.filter.source),
  };
  plugin.setup(builder);
  assert.equal(extraSaw, builder);
  assert.ok(calls.resolve.some((s) => s === "^sharp$"));
  assert.ok(calls.resolve.some((s) => s.includes("obtc-ort-binding")));
  assert.equal(calls.load.length, 3, "sharp stub + transformers + onnxruntime-node binding");
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
  for (const platform of Object.keys(ORT_PLATFORMS)) {
    for (const f of ortNativeFiles(join(embedderModules, "onnxruntime-node"), platform)) {
      assert.ok(existsSync(f.path), `${f.path} exists in the installed onnxruntime-node`);
    }
  }
});
