import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ORT_WASM_MJS = "ort-wasm-simd-threaded.mjs";
export const ORT_WASM_BINARY = "ort-wasm-simd-threaded.wasm";

let wasmNoticeLogged = false;

/** Selects native or web ORT; the shim's package aliases already converge on this returned runtime. */
export function selectOrtRuntime({
  platform = process.platform,
  arch = process.arch,
  runtimeDir,
  loadNative,
  loadWeb,
  readFile = readFileSync,
  log = console.error,
}) {
  if (platform !== "darwin" || arch !== "x64") return loadNative();

  const web = loadWeb();
  const wasmFile = join(runtimeDir, ORT_WASM_BINARY);
  web.env.wasm.wasmPaths = {
    mjs: pathToFileURL(join(runtimeDir, ORT_WASM_MJS)).href,
    wasm: pathToFileURL(wasmFile).href,
  };
  // Node's fetch rejects file: URLs, so hand the bytes to ORT directly. The embedder/reranker
  // entrypoint also disables Transformers' blob:-based useWasmCache path for this backend.
  web.env.wasm.wasmBinary = Uint8Array.from(readFile(wasmFile)).buffer;
  if (!wasmNoticeLogged) {
    wasmNoticeLogged = true;
    log(
      "obsidian-tc: onnxruntime-node has no native binding on darwin-x64 (no published binding); the local embedder runs on onnxruntime-web (WASM) instead.",
    );
  }
  return web;
}
