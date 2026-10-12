// Stands in for transformers.node.mjs's onnx-node import: the same createRequire(import.meta.url)
// lookup of onnxruntime-node that the WASM fallback has to satisfy. Test-only, never shipped.
import { createRequire } from "node:module";

export const ort = createRequire(import.meta.url)("onnxruntime-node");
