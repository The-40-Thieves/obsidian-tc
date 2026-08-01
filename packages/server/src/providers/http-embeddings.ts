// The generic "any OpenAI-shaped endpoint" embedder. Deliberately NOT an alias of openaiProvider:
// a named vendor entry may grow vendor-required fields over time (cohere already sends input_type
// because Cohere v2 mandates it), and this one must be provably unable to.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type FetchFn, postJson } from "../embeddings/http";
import { assertVectors, type EmbeddingProvider } from "../embeddings/provider";

export interface HttpEmbeddingsOpts {
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  truncate?: boolean;
}

export function openAiCompatibleProvider(o: HttpEmbeddingsOpts): EmbeddingProvider {
  if (!o.baseUrl) {
    throw err.invalidInput("embeddings.baseUrl is required for provider 'openai-compatible'", {
      provider: "openai-compatible",
      hint: "set embeddings.baseUrl to the endpoint prefix that precedes /embeddings, e.g. http://127.0.0.1:4000/v1",
    });
  }
  const base = o.baseUrl.replace(/\/+$/, "");
  return {
    id: `openai-compatible:${o.model}`,
    provider: "openai-compatible",
    model: o.model,
    dimensions: o.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      // INVARIANT: exactly {model, input}. `dimensions` 400s every non-Matryoshka backend;
      // `encoding_format` 400s vLLM. Width is enforced below, client-side.
      const r = await postJson<{ data?: Array<{ embedding: number[] }> }>({
        url: `${base}/embeddings`,
        headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
        body: { model: o.model, input: texts },
        fetchFn: o.fetchFn,
        timeoutMs: o.timeoutMs,
        provider: "openai-compatible",
      });
      return assertVectors(
        (r.data ?? []).map((d) => d.embedding),
        o.dimensions,
        texts.length,
        {
          truncate: o.truncate,
        },
      );
    },
  };
}
