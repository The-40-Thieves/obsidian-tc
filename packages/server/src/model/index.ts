// Model-tier ports + the deterministic fakes + concrete adapters. Backends (Rust TEI dense, Python
// BGE-M3 multi-vector) are wired together by composeModelClient and adapted onto the EmbeddingProvider
// seam by buildModelTierProvider at the composition root.
export { type BgeClientOptions, bgeModelClient } from "./bge";
export { composeModelClient, type ModelClientParts } from "./compose";
export {
  buildModelTierProvider,
  type ModelProviderOptions,
  type ModelTierConfigLike,
  type ModelTierDenseConfig,
  type ModelTierFullConfig,
  modelClientProvider,
} from "./factory";
export { fakeGenerationClient, fakeModelClient } from "./fake";
export type {
  CompletionRequest,
  CompletionResult,
  EmbedFullResult,
  EmbedRequest,
  EmbedResult,
  EncodeInput,
  GenerationClient,
  ModelClient,
  MultiVectorEmbedding,
  RepresentationMeta,
  RerankRequest,
  RerankResult,
} from "./ports";
export { type TeiClientOptions, teiModelClient } from "./tei";
