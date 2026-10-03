// Bundling the local embedder (packages/embedder-local + @huggingface/transformers +
// onnxruntime-node) into places that have no node_modules: the .mcpb bundle (scripts/bundle-mcpb.ts)
// and the standalone binaries (scripts/build-binary.ts).
//
// Three things in the dependency tree cannot be bundled as-is, each handled by the Bun plugin below:
//
//   1. transformers.node.mjs reaches onnxruntime-node through `createRequire(import.meta.url)(...)`,
//      a runtime lookup no bundler follows (and a compiled binary has nothing to resolve it
//      against). Rewritten into a plain static import.
//   2. onnxruntime-node's binding.js `require()`s its native addon by a template-literal path.
//      Rewritten to scripts/lib/ort-binding-loader.mjs, which dlopens it from a real directory.
//   3. transformers.node.mjs statically imports `sharp` (image preprocessing, a per-platform native
//      addon). Text embedding never calls it, so it is stubbed.
//
// Every rewrite asserts that it found exactly the text it expects and throws otherwise: the packages
// are pinned exactly (embedder-local's `@huggingface/transformers`), so a drift fails the build here
// instead of shipping a bundle whose embedder cannot load.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the plugin resolves the binding loader the rewritten onnxruntime-node require points at. */
export const ORT_BINDING_LOADER = join(HERE, "ort-binding-loader.mjs");
const ORT_BINDING_SPECIFIER = "obtc-ort-binding";

/**
 * onnxruntime-node's per-platform native files (under `bin/napi-v6/<dir>/`), by `process.platform-
 * process.arch`. Only what the CPU execution provider needs: the binding and the runtime library it
 * is linked against. onnxruntime-node ships no darwin-x64 build, so a standalone binary for that
 * target has no local embedder.
 */
export const ORT_PLATFORMS = {
  "linux-x64": { dir: "linux/x64", files: ["onnxruntime_binding.node", "libonnxruntime.so.1"] },
  "linux-arm64": { dir: "linux/arm64", files: ["onnxruntime_binding.node", "libonnxruntime.so.1"] },
  "darwin-arm64": {
    dir: "darwin/arm64",
    files: ["onnxruntime_binding.node", "libonnxruntime.1.dylib"],
  },
  "win32-x64": { dir: "win32/x64", files: ["onnxruntime_binding.node", "onnxruntime.dll"] },
};

/** bun --compile target -> ORT_PLATFORMS key. A target absent here has no local embedder. */
export const BUN_TARGET_ORT_PLATFORM = {
  "bun-linux-x64": "linux-x64",
  "bun-linux-arm64": "linux-arm64",
  "bun-darwin-arm64": "darwin-arm64",
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
 * The Bun.build plugin applying the three rewrites above. `extra` lets a caller add its own
 * resolvers/loaders to the same build (scripts/build-binary.ts adds the embedded-embedder module).
 */
export function embedderBundlePlugin(extra) {
  return {
    name: "obsidian-tc-embedder-bundle",
    setup(build) {
      build.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "obtc-stub" }));
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
  if (!spec) throw new Error(`embedder-bundle: no onnxruntime-node build for ${platformKey}`);
  return spec.files.map((name) => ({
    name,
    path: join(ortNodeDir, "bin", "napi-v6", ...spec.dir.split("/"), name),
  }));
}
