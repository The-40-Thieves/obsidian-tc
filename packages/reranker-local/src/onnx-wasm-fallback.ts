// Intel macOS (darwin-x64) fallback to onnxruntime-web's WASM backend. A DELIBERATE MIRROR of
// packages/reranker-local/src/onnx-wasm-fallback.ts (byte-identical): the two packages are
// independent install roots, so neither may import the other (see model-fetch.ts's header).
// scripts/check-model-fetch-parity.mjs keeps the pair in step. If this changes, change both.
//
// onnxruntime-node ships no darwin-x64 binary (1.30.0 is darwin-arm64 only), and
// @huggingface/transformers reaches it through a static `createRequire(import.meta.url)` in its
// Node branch, so on Intel macOS that transformers import throws. This runs BEFORE the import: it
// primes Node's CommonJS module cache, under the exact path transformers resolves
// onnxruntime-node to, with onnxruntime-web's CommonJS build. Transformers' own Node branch then
// runs unchanged on web's runtime. Every other platform returns at once: nothing is probed,
// primed or logged.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Which ONNX runtime the transformers import will see. */
export type OnnxBackend = { backend: "native" } | { backend: "wasm"; reason: string };

/** Test seams. Production callers pass none. */
export interface OnnxBackendOptions {
  /** The transformers entry file whose require() graph reaches onnxruntime-node. Defaults to the
   *  ESM entry transformers is imported from. */
  transformersEntry?: string;
  /** Requires onnxruntime-node from `transformersEntry`; throws when its native binding is missing. */
  loadNative?: (transformersEntry: string) => unknown;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Where the one-time notice goes. Defaults to stderr: stdout is the MCP stdio channel. */
  log?: (message: string) => void;
}

interface OrtWeb {
  env: { wasm: { wasmPaths?: { mjs: string; wasm: string }; wasmBinary?: ArrayBuffer } };
}

/** The Module-shaped cache entry this file writes. `obtcOnnxWebFallback` carries the reason, so a
 *  later call recognises the entry and stays quiet. */
interface PrimedModule {
  id: string;
  filename: string;
  loaded: true;
  exports: OrtWeb;
  children: never[];
  paths: never[];
  obtcOnnxWebFallback: string;
}

export async function ensureOnnxBackend(opts: OnnxBackendOptions = {}): Promise<OnnxBackend> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "x64") return { backend: "native" };

  const transformersEntry =
    opts.transformersEntry ?? fileURLToPath(import.meta.resolve("@huggingface/transformers"));
  const fromTransformers = createRequire(transformersEntry);
  const resolved = fromTransformers.resolve("onnxruntime-node");
  const cache = createRequire(import.meta.url).cache as Record<string, unknown>;

  const primed = cache[resolved] as Partial<PrimedModule> | undefined;
  if (primed?.obtcOnnxWebFallback !== undefined) {
    return { backend: "wasm", reason: primed.obtcOnnxWebFallback };
  }

  const loadNative = opts.loadNative ?? (() => fromTransformers("onnxruntime-node"));
  try {
    loadNative(transformersEntry);
    return { backend: "native" };
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    const reason = `onnxruntime-node has no native binding on darwin-x64 (${why})`;
    const web = fromTransformers("onnxruntime-web") as OrtWeb;
    const webEntry = fromTransformers.resolve("onnxruntime-web");
    const dist = webEntry.replace(/ort\.node\.min\.js$/, "");
    const wasmFile = `${dist}ort-wasm-simd-threaded.wasm`;
    web.env.wasm.wasmPaths = {
      mjs: pathToFileURL(`${dist}ort-wasm-simd-threaded.mjs`).href,
      wasm: pathToFileURL(wasmFile).href,
    };
    // Node's fetch rejects file: URLs, so the WASM bytes are read here and handed over directly.
    web.env.wasm.wasmBinary = new Uint8Array(readFileSync(wasmFile)).buffer;
    const record: PrimedModule = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: web,
      children: [],
      paths: [],
      obtcOnnxWebFallback: reason,
    };
    cache[resolved] = record;
    (opts.log ?? console.error)(
      `obsidian-tc: ${reason}; the local embedder runs on onnxruntime-web (WASM) instead.`,
    );
    return { backend: "wasm", reason };
  }
}
