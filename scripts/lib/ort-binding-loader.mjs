// The one place the bundled local embedder loads onnxruntime-node's native binding from.
//
// onnxruntime-node's own binding.js does a template-literal `require()` of
// `../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`, which a bundler cannot follow and a
// `bun build --compile` binary cannot satisfy (nothing to resolve against). scripts/lib/
// embedder-bundle.mjs rewrites that one expression to call loadOrtBinding() below, so the same
// patched module works in both places a bundle of the embedder is shipped:
//
//   .mcpb bundle       the binding + libonnxruntime sit in `ort/<platform>-<arch>/` next to the
//                      bundled embedder file (the default below).
//   compiled binary    the files are embedded in the executable and extracted at first use; the
//                      server's local-embedder-registry sets ORT_DIR_KEY to the
//                      extracted directory before loading the embedder.
//
// The binding is loaded with process.dlopen from a REAL directory (never from inside the
// executable) because onnxruntime_binding.node finds libonnxruntime next to itself ($ORIGIN /
// @loader_path / the DLL's own directory).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ORT_DIR_KEY = Symbol.for("obsidian-tc.ort-dir");

export function loadOrtBinding() {
  const dir =
    globalThis[ORT_DIR_KEY] ??
    join(dirname(fileURLToPath(import.meta.url)), "ort", `${process.platform}-${process.arch}`);
  const file = join(dir, "onnxruntime_binding.node");
  const mod = { exports: {} };
  try {
    process.dlopen(mod, file);
  } catch (e) {
    throw new Error(
      `could not load the onnxruntime native binding from ${file} (${process.platform}-${process.arch}): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  return mod.exports;
}
