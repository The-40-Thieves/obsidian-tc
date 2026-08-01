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
  model: z.string().min(1).describe("Rerank model name as the provider names it."),
  // z.url(), not z.string().url() — the latter is deprecated in Zod 4.
  baseUrl: z
    .url()
    .optional()
    .describe(
      "Endpoint prefix preceding /rerank. Include the dialect version segment: Cohere rerank v2 replaced v1's max_chunks_per_doc with max_tokens_per_doc, and this prefix selects the dialect.",
    ),
  apiKey: z.string().optional().describe("Provider API key. Secret — never logged."),
  apiKeyEnv: z
    .string()
    .min(1)
    .optional()
    .describe("Environment variable holding the API key. Inline apiKey wins."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout in ms for a single rerank request."),
  modulePath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Module exporting createReranker, for provider 'module'. Refused under the hardened security profile.",
    ),
});
export type RerankerConfig = z.infer<typeof RerankerConfigSchema>;
