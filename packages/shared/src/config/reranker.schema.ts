// The reranker slot's PROVIDER-SELECTION surface. Rerank BEHAVIOUR flags already exist
// (retrieval.gatedRerank, retrieval.colbert, experiential.activationRerank); what never existed is
// a way to name WHICH backend answers. Leaf schema — imports Zod only.
import { z } from "zod";

export const RerankerConfigSchema = z.object({
  provider: z
    .string()
    .min(1)
    .describe(
      "Reranker backend name, resolved against the provider registry at startup. Built-ins: cohere-compatible (any Cohere-format /rerank endpoint), model-tier (the BGE cross-encoder, configured via embeddings.modelTier.full), gateway (the inference gateway passthrough), and the profile-gated module.",
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
      "Module exporting createReranker, for provider 'module'. Refused under the hardened security profile.",
    ),
});
export type RerankerConfig = z.infer<typeof RerankerConfigSchema>;
