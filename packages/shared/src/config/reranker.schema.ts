// The reranker slot's PROVIDER-SELECTION surface. Rerank BEHAVIOUR flags already exist
// (retrieval.gatedRerank, retrieval.colbert, experiential.activationRerank); what never existed is
// a way to name WHICH backend answers. Leaf schema — imports Zod only.
import { z } from "zod";

export const RerankerConfigSchema = z.object({
  provider: z
    .string()
    .min(1)
    .describe(
      "Reranker backend name, resolved against the provider registry at startup. Built-ins: cohere-compatible (any Cohere-format /rerank endpoint), model-tier (the BGE cross-encoder, configured via embeddings.modelTier.full), gateway (the inference gateway passthrough), local (THE-705/THE-944: a bundled, fully offline cross-encoder — no gateway or Python service required; requires the optional @the-40-thieves/obsidian-tc-reranker-local package, and is also tried AUTOMATICALLY — no need to set provider: 'local' explicitly — when this whole block is left unset, model-tier is not configured, and no gateway URL is configured either), and the profile-gated module.",
    ),
  // Optional at the schema level because "required" is not uniform across entries: cohere-compatible
  // genuinely needs one and throws its own actionable boot error when it is absent; model-tier
  // ignores it entirely (its model comes from embeddings.modelTier.full.model) and throws its own
  // boot error if an operator sets it anyway, so no entry is ever silently missing or ignoring it.
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Rerank model name as the provider names it. Required by cohere-compatible (refused at boot if absent). Ignored — and refused at boot if set — by model-tier, which sources its model from embeddings.modelTier.full.model. Optional for gateway: omitting it silently falls back to the model literal "rerank".',
    ),
  // z.url(), not z.string().url() — the latter is deprecated in Zod 4.
  baseUrl: z
    .url()
    .optional()
    .describe(
      "Endpoint prefix preceding /rerank. Include the dialect version segment: Cohere rerank v2 replaced v1's max_chunks_per_doc with max_tokens_per_doc, and this prefix selects the dialect. Ignored — and refused at boot if set — by model-tier, which sources its endpoint from embeddings.modelTier.full.baseUrl.",
    ),
  apiKey: z
    .string()
    .optional()
    .describe(
      "Provider API key. Secret — never logged. Ignored — and refused at boot if set — by model-tier, which sources auth from embeddings.modelTier.full.authToken.",
    ),
  apiKeyEnv: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Environment variable holding the API key. Inline apiKey wins. Ignored — and refused at boot if set — by model-tier (see apiKey).",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Timeout in ms for a single rerank request. Ignored — and refused at boot if set — by model-tier, which uses embeddings.timeoutMs instead.",
    ),
  modulePath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Module exporting createReranker, for provider 'module'. Resolved against the config file's directory. Refused under the hardened security profile. The factory may be sync or async (an async factory is awaited). It must return a function: (query, documents, topN) => Promise<RerankHit[]>. Validated at load time, before first use.",
    ),
  // THE-705. Only read by provider "local" — ignored, and refused at boot if set, by every other
  // entry (same "declared but not consumed by this backend" contract as model, baseUrl, apiKey,
  // apiKeyEnv, timeoutMs above).
  localModelPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute path to the ROOT directory under which <model-id>/<revision>/ lives (config.json, tokenizer.json, onnx/model_int8.onnx — see @the-40-thieves/obsidian-tc-reranker-local's README) for provider 'local'. THE-944: no longer required to be pre-populated — fetched and sha256-verified automatically on the first rerank call if not already present. Defaults to that package's own models/ directory. `bun run fetch-model` still works, for offline/CI pre-population. Ignored — and refused at boot if set — by every other provider.",
    ),
  // THE-705 round 2: route (i) of provider "local"'s resolution ladder (registry.ts's
  // resolveLocalRerankerModule) — the escape hatch for every deployment shape the bare package
  // specifier and the source-checkout default don't cover (an npm-installed server pointed at a
  // reranker-local checkout elsewhere, a container image vendoring the built package at a fixed
  // path, ...). Only read by provider "local".
  localModulePath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Explicit path to @the-40-thieves/obsidian-tc-reranker-local's BUILT module entry (its dist/index.js), for provider 'local'. Absolute, or resolved against the config file's directory (same convention as modulePath). Tried FIRST, before the bare package specifier and the source-checkout default — see that package's README for when you need this. Ignored by every other provider.",
    ),
});
export type RerankerConfig = z.infer<typeof RerankerConfigSchema>;
