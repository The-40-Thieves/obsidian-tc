// Bundling the local embedder (packages/embedder-local + @huggingface/transformers + one selected
// ONNX runtime) into places that have no node_modules: the .mcpb bundle (scripts/bundle-mcpb.ts)
// and standalone binaries (scripts/build-binary.ts).
//
// Four things in the dependency tree cannot be bundled as-is, each handled by the Bun plugin below:
//
//   1. transformers.node.mjs reaches onnxruntime-node through a runtime-only CommonJS lookup that
//      no bundler follows (and a compiled binary has nothing to resolve it against). Rewritten into
//      a plain static import.
//   2. Both ONNX package specifiers must share one runtime. They resolve to ort-runtime-shim.mjs,
//      whose bare private requires stay visible to Bun and resolve to the real native/web entries.
//   3. onnxruntime-node's binding.js `require()`s its native addon by a template-literal path.
//      Rewritten to scripts/lib/ort-binding-loader.mjs, which dlopens it from a real directory.
//   4. transformers.node.mjs statically imports `sharp` (image preprocessing, a per-platform native
//      addon). Text embedding never calls it, so it is stubbed.
//
// Every rewrite asserts that it found exactly the text it expects and throws otherwise: the packages
// are pinned exactly (embedder-local's `@huggingface/transformers`), so a drift fails the build here
// instead of shipping a bundle whose embedder cannot load.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORT_WASM_BINARY, ORT_WASM_MJS } from "./ort-runtime-selection.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the plugin resolves the binding loader the rewritten onnxruntime-node require points at. */
export const ORT_BINDING_LOADER = join(HERE, "ort-binding-loader.mjs");
export const ORT_RUNTIME_SHIM = join(HERE, "ort-runtime-shim.mjs");
const ORT_BINDING_SPECIFIER = "obtc-ort-binding";
const ORT_NATIVE_SPECIFIER = "obtc-ort-native";
const ORT_WEB_SPECIFIER = "obtc-ort-web";
const EMBEDDER_PACKAGE_JSON = join(HERE, "..", "..", "packages", "embedder-local", "package.json");

// Resolve lazily inside a real build. The root lint job deliberately does not install this optional
// package's private dependency tree, but it still imports this module to run its seam-only tests.
const resolveFromEmbedder = (specifier) => createRequire(EMBEDDER_PACKAGE_JSON).resolve(specifier);

/**
 * Bundled ONNX backend by `process.platform-process.arch`. Native entries name the files under
 * `bin/napi-v6/<dir>/` needed by the CPU execution provider. darwin-x64 uses the two web WASM
 * assets instead because onnxruntime-node does not publish that native binding.
 */
export const ORT_PLATFORMS = {
  "linux-x64": {
    backend: "native",
    dir: "linux/x64",
    files: ["onnxruntime_binding.node", "libonnxruntime.so.1"],
  },
  "linux-arm64": {
    backend: "native",
    dir: "linux/arm64",
    files: ["onnxruntime_binding.node", "libonnxruntime.so.1"],
  },
  "darwin-arm64": {
    backend: "native",
    dir: "darwin/arm64",
    files: ["onnxruntime_binding.node", "libonnxruntime.1.dylib"],
  },
  "darwin-x64": { backend: "wasm" },
  "win32-x64": {
    backend: "native",
    dir: "win32/x64",
    files: ["onnxruntime_binding.node", "onnxruntime.dll"],
  },
};

/** bun --compile target -> ORT_PLATFORMS key. A future target absent here has no local embedder. */
export const BUN_TARGET_ORT_PLATFORM = {
  "bun-linux-x64": "linux-x64",
  "bun-linux-arm64": "linux-arm64",
  "bun-darwin-arm64": "darwin-arm64",
  "bun-darwin-x64": "darwin-x64",
  "bun-windows-x64": "win32-x64",
};

function replaceExactlyOnce(src, needle, replacement, what) {
  const first = src.indexOf(needle);
  if (first === -1 || src.indexOf(needle, first + 1) !== -1) {
    throw new Error(
      `embedder-bundle: expected exactly one occurrence of ${what} (${JSON.stringify(needle)}); ` +
        "the pinned dependency changed shape. Update scripts/lib/embedder-bundle.mjs.",
    );
  }
  return src.slice(0, first) + replacement + src.slice(first + needle.length);
}

/** transformers.node.mjs: the runtime `requireFromHere("onnxruntime-node")` becomes a static import. */
export function patchTransformersSource(src) {
  return replaceExactlyOnce(
    src,
    'var onnx_node_default = requireFromHere("onnxruntime-node");',
    'import __obtcOrtNode from "onnxruntime-node";\nvar onnx_node_default = __obtcOrtNode;',
    "transformers' onnxruntime-node require",
  );
}

/** onnxruntime-node's dist/binding.js: the native-addon require goes through the binding loader. */
export function patchOrtBindingSource(src) {
  return replaceExactlyOnce(
    src,
    `require(\`../bin/napi-v6/\${process.platform}/\${process.arch}/onnxruntime_binding.node\`)`,
    `require(${JSON.stringify(ORT_BINDING_SPECIFIER)}).loadOrtBinding()`,
    "onnxruntime-node's native binding require",
  );
}

export const SHARP_STUB = `export default function sharp() {
  throw new Error("sharp is not bundled: obsidian-tc only runs text embedding models, which need no image processing");
}
`;

const TRANSFORMERS_NODE_FILE =
  /[\\/]@huggingface[\\/]transformers[\\/]dist[\\/]transformers\.node\.mjs$/;
const ORT_BINDING_FILE = /[\\/]onnxruntime-node[\\/]dist[\\/]binding\.js$/;

/**
 * The Bun.build plugin applying the rewrites and runtime aliases above. `extra` lets a caller add
 * its own resolvers/loaders to the same build (build-binary.ts adds the embedded-embedder module).
 */
export function embedderBundlePlugin(extra) {
  return {
    name: "obsidian-tc-embedder-bundle",
    setup(build) {
      build.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "obtc-stub" }));
      build.onResolve({ filter: /^onnxruntime-(?:node|web)$/ }, () => ({
        path: ORT_RUNTIME_SHIM,
      }));
      build.onResolve({ filter: new RegExp(`^${ORT_NATIVE_SPECIFIER}$`) }, () => ({
        path: resolveFromEmbedder("onnxruntime-node"),
      }));
      build.onResolve({ filter: new RegExp(`^${ORT_WEB_SPECIFIER}$`) }, () => ({
        path: resolveFromEmbedder("onnxruntime-web"),
      }));
      build.onLoad({ filter: /.*/, namespace: "obtc-stub" }, () => ({
        contents: SHARP_STUB,
        loader: "js",
      }));
      build.onResolve({ filter: new RegExp(`^${ORT_BINDING_SPECIFIER}$`) }, () => ({
        path: ORT_BINDING_LOADER,
      }));
      build.onLoad({ filter: TRANSFORMERS_NODE_FILE }, ({ path }) => ({
        contents: patchTransformersSource(readFileSync(path, "utf8")),
        loader: "js",
      }));
      build.onLoad({ filter: ORT_BINDING_FILE }, ({ path }) => ({
        contents: patchOrtBindingSource(readFileSync(path, "utf8")),
        loader: "js",
      }));
      extra?.(build);
    },
  };
}

/** Absolute directory of onnxruntime-node's native files for `platformKey`, under `ortNodeDir`. */
export function ortNativeFiles(ortNodeDir, platformKey) {
  const spec = ORT_PLATFORMS[platformKey];
  if (spec?.backend !== "native") {
    throw new Error(`embedder-bundle: no onnxruntime-node build for ${platformKey}`);
  }
  return spec.files.map((name) => ({
    name,
    path: join(ortNodeDir, "bin", "napi-v6", ...spec.dir.split("/"), name),
  }));
}

/** WASM loader and binary used by the darwin-x64 bundled runtime. */
export function ortWasmFiles(ortWebDir) {
  return [ORT_WASM_MJS, ORT_WASM_BINARY].map((name) => ({
    name,
    path: join(ortWebDir, "dist", name),
  }));
}

/** Runtime files embedded in a standalone binary for one ORT platform. */
export function ortRuntimeFiles(ortNodeDir, ortWebDir, platformKey) {
  const spec = ORT_PLATFORMS[platformKey];
  if (!spec) throw new Error(`embedder-bundle: no ONNX runtime for ${platformKey}`);
  return spec.backend === "wasm"
    ? ortWasmFiles(ortWebDir)
    : ortNativeFiles(ortNodeDir, platformKey);
}
