// THE-1122 — pinned model provenance for the bundled local embedder. This is the ONLY place model
// identity, revision and per-file checksums are declared for each supported catalog entry;
// scripts/fetch-model.mjs and index.ts's default path both derive from it, so there is exactly one
// place to bump when a pinned revision changes. Mirrors packages/reranker-local/src/model-info.ts's
// role for its one cross-encoder — this catalog holds several, because `embeddings.model` is a
// user-facing choice (unlike the reranker, which has none).
//
// Deliberately plain data, not code that reaches the network — importing this file must never have
// a side effect, so both the fetch script (which DOES reach the network) and index.ts's lazy loader
// (which must NOT, at import time) can share it safely.
//
// WHY A CLOSED CATALOG, NOT "any embeddings.model string": checksum verification requires knowing
// the exact pinned bytes ahead of time. `embeddings.provider: "local"` therefore only supports the
// models below — an unrecognized `embeddings.model` under this provider is refused with an
// actionable error naming the supported set (see index.ts's `catalogEntryOrThrow`).
//
// WHY EACH ENTRY HAS TWO ONNX VARIANTS: `embeddings.quantized` (default true) is a real, threaded
// config knob, not decorative — toggling it must actually change which bytes are fetched and
// loaded, so both the quantized (q8) and full-precision (fp32) ONNX export are pinned and
// checksummed per model. The non-ONNX files (tokenizer/config) are dtype-independent and shared.

export interface PinnedFile {
  /** Path relative to the model repo root, e.g. "onnx/model_quantized.onnx". */
  path: string;
  /** Verified against the file's actual bytes at the pinned revision (sha256, computed directly —
   *  downloaded + sha256sum — on 2026-09-24). */
  sha256: string;
  sizeBytes: number;
}

export interface EmbeddingModelInfo {
  /** The catalog key — what `embeddings.model` must equal under `provider: "local"`. */
  name: string;
  /** The upstream HF repo Transformers.js resolves against. */
  modelId: string;
  /** Pinned commit on the model repo (not a branch) — a revision, not a moving target, so the
   *  files below can be checksum-verified against something that cannot change out from under
   *  this pin. */
  revision: string;
  /** Native output width before any `embeddings.dimensions`/`truncate` handling. */
  dimensions: number;
  /** The pooling strategy this model's own `1_Pooling/config.json` (or model card) declares —
   *  Transformers.js's `feature-extraction` pipeline `pooling` option. NOT a free choice: using
   *  the wrong one silently produces valid-looking but degraded vectors (caught mid-development —
   *  bge-small-en-v1.5 is CLS, not mean, and was first measured with mean pooling applied
   *  uniformly to every catalog entry). */
  pooling: "mean" | "cls";
  /** License identifier, as recorded on the model card at pin time — see docs/EVALUATION.md and
   *  this file's header comment for why a candidate that was DROPPED (EmbeddingGemma, model2vec)
   *  has no catalog entry at all. */
  license: string;
  /** Files present regardless of `embeddings.quantized` (tokenizer/config — dtype-independent). */
  sharedFiles: readonly PinnedFile[];
  quantized: { dtype: string; onnxFile: PinnedFile };
  fp32: { dtype: string; onnxFile: PinnedFile };
}

/** The exact file set for one catalog entry at the requested precision — shared files plus the ONE
 *  onnx variant that setting actually selects. */
export function pinnedFilesFor(info: EmbeddingModelInfo, quantized: boolean): PinnedFile[] {
  const variant = quantized ? info.quantized : info.fp32;
  return [...info.sharedFiles, variant.onnxFile];
}

export function dtypeFor(info: EmbeddingModelInfo, quantized: boolean): string {
  return quantized ? info.quantized.dtype : info.fp32.dtype;
}

const ALL_MINILM_L6_V2: EmbeddingModelInfo = {
  name: "all-MiniLM-L6-v2",
  modelId: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dimensions: 384,
  // sentence-transformers/all-MiniLM-L6-v2's 1_Pooling/config.json: pooling_mode_mean_tokens=true.
  pooling: "mean",
  license: "apache-2.0",
  sharedFiles: [
    {
      path: "config.json",
      sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
      sizeBytes: 650,
    },
    {
      path: "tokenizer.json",
      sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
      sizeBytes: 711661,
    },
    {
      path: "tokenizer_config.json",
      sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
      sizeBytes: 366,
    },
  ],
  quantized: {
    dtype: "q8",
    onnxFile: {
      path: "onnx/model_quantized.onnx",
      sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
      sizeBytes: 22972370,
    },
  },
  fp32: {
    dtype: "fp32",
    onnxFile: {
      path: "onnx/model.onnx",
      sha256: "759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e",
      sizeBytes: 90387606,
    },
  },
};

const BGE_SMALL_EN_V1_5: EmbeddingModelInfo = {
  name: "bge-small-en-v1.5",
  modelId: "Xenova/bge-small-en-v1.5",
  revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
  dimensions: 384,
  // BAAI/bge-small-en-v1.5's 1_Pooling/config.json: pooling_mode_cls_token=true (mean=false). The
  // model card confirms: "select the last hidden state of the FIRST token (i.e. [CLS]) as the
  // sentence embedding." A first measurement applied mean pooling uniformly to every catalog
  // entry — this model's correct pooling was caught mid-development, before the default was
  // chosen, and the measurement re-run with this fix in place (see docs/EVALUATION.md).
  pooling: "cls",
  license: "mit",
  sharedFiles: [
    {
      path: "config.json",
      sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
      sizeBytes: 683,
    },
    {
      path: "tokenizer.json",
      sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      sizeBytes: 711396,
    },
    {
      path: "tokenizer_config.json",
      sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
      sizeBytes: 366,
    },
  ],
  quantized: {
    dtype: "q8",
    onnxFile: {
      path: "onnx/model_quantized.onnx",
      sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
      sizeBytes: 34014426,
    },
  },
  fp32: {
    dtype: "fp32",
    onnxFile: {
      path: "onnx/model.onnx",
      sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
      sizeBytes: 133093490,
    },
  },
};

const NOMIC_EMBED_TEXT_V1_5: EmbeddingModelInfo = {
  name: "nomic-embed-text-v1.5",
  modelId: "nomic-ai/nomic-embed-text-v1.5",
  revision: "e9b6763023c676ca8431644204f50c2b100d9aab",
  dimensions: 768,
  // nomic-ai/nomic-embed-text-v1.5's 1_Pooling/config.json: pooling_mode_mean_tokens=true.
  pooling: "mean",
  license: "apache-2.0",
  sharedFiles: [
    {
      path: "config.json",
      sha256: "9ab00bd92cee80a569f708140b7b6c1661a65891ff3765b1519e181ba2f2c92b",
      sizeBytes: 2538,
    },
    {
      path: "tokenizer.json",
      sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      sizeBytes: 711396,
    },
    {
      path: "tokenizer_config.json",
      sha256: "d7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc",
      sizeBytes: 1191,
    },
  ],
  quantized: {
    dtype: "q8",
    onnxFile: {
      path: "onnx/model_quantized.onnx",
      sha256: "b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27",
      sizeBytes: 137296292,
    },
  },
  fp32: {
    dtype: "fp32",
    onnxFile: {
      path: "onnx/model.onnx",
      sha256: "147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965",
      sizeBytes: 547310275,
    },
  },
};

/** THE-1122 research brief: EmbeddingGemma-300M (onnx-community/embeddinggemma-300m-ONNX) was
 *  evaluated as a candidate and DROPPED before the measurement stage — its model card license is
 *  "gemma" (Google's Gemma Terms of Use), not an OSI-approved open-source license. The Gemma terms
 *  carry a Prohibited Use Policy Google may update unilaterally and redistribution obligations
 *  (trademark notice, terms pass-through) that do not fit "auto-downloaded by default from every
 *  install of an AGPL-3.0 public server" — a user would be bound to those terms without having
 *  agreed to them. Left undeclared here (no catalog entry) rather than declared-and-refused, since
 *  it is not close to being supportable.
 *
 *  A model2vec/potion static-embedding model (minishlab/potion-retrieval-32M, MIT) was also
 *  evaluated as the low-RAM tier. Its ONNX export uses `model_type: "model2vec"` /
 *  `architectures: ["StaticModel"]`, which Transformers.js 4.3.0 does not register — probed
 *  directly (2026-09-24): `pipeline("feature-extraction", "minishlab/potion-retrieval-32M")` falls
 *  back to a generic EncoderOnly wrapper and fails at inference with "Missing the following
 *  inputs: offsets" (model2vec's bag-embedding ONNX graph has a different input contract than the
 *  transformer models Transformers.js's generic wrapper assumes). No Transformers.js-loadable
 *  export exists for this architecture today, so it is dropped per the brief's own conditional
 *  ("...if a Transformers.js-loadable export exists"). */
export const MODEL_CATALOG: readonly EmbeddingModelInfo[] = [
  ALL_MINILM_L6_V2,
  BGE_SMALL_EN_V1_5,
  NOMIC_EMBED_TEXT_V1_5,
];

/** THE-1122 measurement (docs/EVALUATION.md "Local embedder model selection"): the DEFAULT model
 *  for `embeddings.provider: "local"` when `embeddings.model` is unset. MUST stay in sync with
 *  packages/shared/src/config/indexing-embeddings.schema.ts's `LOCAL_DEFAULT_MODEL` literal — a
 *  schema leaf cannot import this optional, non-workspace package (see model-fetch.ts's header for
 *  why), so that constant is a duplicated literal; test/model-info.test.ts asserts this exact
 *  string so a future change to one is caught, not just documented.
 *
 *  NOT the smallest/fastest candidate — measured, each model run through the SAME code path with
 *  ITS OWN correct pooling strategy (see `pooling` above). Both 384-dim candidates FAILED the
 *  ticket's own −0.015 non-inferiority floor (strict nDCG@10 one-sided 95% lower bound: MiniLM
 *  −0.151, bge-small −0.110, both below −0.015; n=78) — MiniLM's deficit is clearly significant
 *  (p=0.0014); bge-small's nDCG@10 does not reach conventional significance at this n (p=0.10) but
 *  still fails the floor on its own lower bound, and its recall@10 IS significant (p=0.0489). Read
 *  this as the conservative default under a comparison this corpus does not power precisely, not
 *  as a clean win — see docs/EVALUATION.md's "Local embedder model selection" section for the
 *  full table and the exact caveats. */
export const DEFAULT_MODEL_NAME = "nomic-embed-text-v1.5";

export function modelInfoByName(name: string): EmbeddingModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.name === name);
}

export function catalogModelNames(): string[] {
  return MODEL_CATALOG.map((m) => m.name);
}
