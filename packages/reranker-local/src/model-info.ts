// THE-705 — pinned model provenance. This is the ONLY place the model identity, revision and
// per-file checksums are declared; scripts/fetch-model.mjs and index.ts's default path both derive
// from it, so there is exactly one place to bump when the pinned revision changes.
//
// Deliberately plain data, not code that reaches the network — importing this file must never have
// a side effect, so both the fetch script (which DOES reach the network) and index.ts's lazy loader
// (which must NOT, at import time — see the header comment on index.ts) can share it safely.

/** The upstream HF repo. ONNX export of cross-encoder/ms-marco-MiniLM-L6-v2 (Apache-2.0), chosen
 *  in the THE-705 research brief as the best quality/latency/size tradeoff for CPU inference: 22.7M
 *  params, int8 ONNX ~23 MB, the de facto default CPU cross-encoder. */
export const MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";

/** Pinned commit on the model repo (not a branch) — a revision, not a moving target, so the files
 *  below can be checksum-verified against something that cannot change out from under this pin. */
export const MODEL_REVISION = "a09144355adeed5f58c8ed011d209bf8ee5a1fec";

/** dtype selects the `_int8` file suffix (Transformers.js `DEFAULT_DTYPE_SUFFIX_MAPPING`), which is
 *  why the pinned file below is `onnx/model_int8.onnx`, not `onnx/model_quantized.onnx` (`q8`) or
 *  the fp32 original. */
export const MODEL_DTYPE = "int8";

export interface PinnedFile {
  /** Path relative to the model repo root, e.g. "onnx/model_int8.onnx". */
  path: string;
  /** Verified against the HF API's reported LFS sha256 for the LFS-tracked ONNX file, and computed
   *  directly (downloaded + sha256sum) for the small non-LFS text/JSON files, both at MODEL_REVISION
   *  on 2026-08-18. */
  sha256: string;
  sizeBytes: number;
}

/** Every file `env.localModelPath` needs on disk for AutoTokenizer + AutoModelForSequenceClassification
 *  to load MODEL_ID at dtype "int8" with allowRemoteModels=false — no more, no less. */
export const PINNED_FILES: readonly PinnedFile[] = [
  {
    path: "config.json",
    sha256: "d827779a72d27ae68cf878a6fc2e954542663fe21ca515d9f4783fc96be2d37e",
    sizeBytes: 824,
  },
  {
    path: "tokenizer.json",
    sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    sizeBytes: 711396,
  },
  {
    path: "tokenizer_config.json",
    sha256: "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53",
    sizeBytes: 1242,
  },
  {
    path: "special_tokens_map.json",
    sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
    sizeBytes: 125,
  },
  {
    path: "vocab.txt",
    sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
    sizeBytes: 231508,
  },
  {
    path: "onnx/model_int8.onnx",
    sha256: "a13ec391ca99f49886694e12d3e800521f36d4267d7d448c34421c541a2baf50",
    sizeBytes: 23012404,
  },
];
