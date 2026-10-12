// Both public ONNX package specifiers resolve here in bundled local embedders. The private requires
// must remain bare and bundler-visible: embedder-bundle.mjs resolves them to the real native/web
// entries, avoiding alias recursion while guaranteeing Transformers.js imports one runtime.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { selectOrtRuntime } from "./ort-runtime-selection.mjs";

const runtimeDir =
  globalThis[Symbol.for("obsidian-tc.ort-dir")] ?? dirname(fileURLToPath(import.meta.url));
const runtime = selectOrtRuntime({
  runtimeDir,
  loadNative: () => require("obtc-ort-native"),
  loadWeb: () => require("obtc-ort-web"),
});

export default runtime;
export const InferenceSession = runtime.InferenceSession;
export const TRACE = runtime.TRACE;
export const TRACE_EVENT_BEGIN = runtime.TRACE_EVENT_BEGIN;
export const TRACE_EVENT_END = runtime.TRACE_EVENT_END;
export const TRACE_FUNC_BEGIN = runtime.TRACE_FUNC_BEGIN;
export const TRACE_FUNC_END = runtime.TRACE_FUNC_END;
export const Tensor = runtime.Tensor;
export const env = runtime.env;
export const listSupportedBackends = runtime.listSupportedBackends;
export const registerBackend = runtime.registerBackend;
