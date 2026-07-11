import { bgeM3VllmEncode } from "./bge-m3";
import { type FetchFn, postJson } from "./http";
import {
  assertVectors,
  type EmbeddingProvider,
  type EmbedOptions,
  type MultiVectorEmbedding,
} from "./provider";
export interface AdapterOpts {
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  /** THE-387: Matryoshka (MRL) truncation — accept a wider native output and truncate to
   *  `dimensions`. Off by default; a non-MRL width mismatch still errors. */
  truncate?: boolean;
}
function bearer(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}
export function ollamaProvider(o: AdapterOpts): EmbeddingProvider {
  const base = o.baseUrl ?? "http://127.0.0.1:11434";
  return {
    id: `ollama:${o.model}`,
    provider: "ollama",
    model: o.model,
    dimensions: o.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const r = await postJson<{ embeddings: number[][] }>({
        url: `${base}/api/embed`,
        body: { model: o.model, input: texts },
        fetchFn: o.fetchFn,
        timeoutMs: o.timeoutMs,
        provider: "ollama",
      });
      return assertVectors(r.embeddings ?? [], o.dimensions, texts.length, {
        truncate: o.truncate,
      });
    },
  };
}
function openAiStyle(provider: string, defaultBase: string) {
  return (o: AdapterOpts): EmbeddingProvider => {
    const base = o.baseUrl ?? defaultBase;
    return {
      id: `${provider}:${o.model}`,
      provider,
      model: o.model,
      dimensions: o.dimensions,
      async embed(texts: string[]): Promise<number[][]> {
        const r = await postJson<{ data: Array<{ embedding: number[] }> }>({
          url: `${base}/embeddings`,
          headers: bearer(o.apiKey),
          body: { model: o.model, input: texts },
          fetchFn: o.fetchFn,
          timeoutMs: o.timeoutMs,
          provider,
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
  };
}
export const openaiProvider = openAiStyle("openai", "https://api.openai.com/v1");
export const voyageProvider = openAiStyle("voyage", "https://api.voyageai.com/v1");
export function cohereProvider(o: AdapterOpts): EmbeddingProvider {
  const base = o.baseUrl ?? "https://api.cohere.com/v2";
  return {
    id: `cohere:${o.model}`,
    provider: "cohere",
    model: o.model,
    dimensions: o.dimensions,
    async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
      // THE-308: Cohere v3 embeddings are asymmetric — encode a search query as search_query,
      // not as a document, or query and document vectors land in different subspaces and recall
      // drops. Indexing (the default) stays search_document.
      const inputType = opts?.input === "query" ? "search_query" : "search_document";
      const r = await postJson<{ embeddings: { float: number[][] } }>({
        url: `${base}/embed`,
        headers: bearer(o.apiKey),
        body: { model: o.model, texts, input_type: inputType, embedding_types: ["float"] },
        fetchFn: o.fetchFn,
        timeoutMs: o.timeoutMs,
        provider: "cohere",
      });
      return assertVectors(r.embeddings?.float ?? [], o.dimensions, texts.length, {
        truncate: o.truncate,
      });
    },
  };
}

// THE-395: the configurable bge-m3 multi-representation provider — a vLLM server started with
//   vllm serve BAAI/bge-m3 --hf-overrides '{"architectures":["BgeM3EmbeddingModel"]}'
// embed() is the plain dense head (OpenAI-compatible /embeddings, so the query/index dense path
// matches every other provider); embedFull() adds the learned-sparse + ColBERT heads (THE-388
// encoder), which the indexer persists to chunk_sparse / chunk_colbert.
export function bgeM3Provider(o: AdapterOpts): EmbeddingProvider {
  const base = (o.baseUrl ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "");
  const model = o.model || "BAAI/bge-m3";
  return {
    id: `bge-m3:${model}`,
    provider: "bge-m3",
    model,
    dimensions: o.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const r = await postJson<{ data: Array<{ embedding: number[] }> }>({
        url: `${base}/embeddings`,
        body: { model, input: texts },
        fetchFn: o.fetchFn,
        timeoutMs: o.timeoutMs,
        provider: "bge-m3-vllm",
      });
      return assertVectors(
        (r.data ?? []).map((d) => d.embedding),
        o.dimensions,
        texts.length,
        { truncate: o.truncate },
      );
    },
    async embedFull(texts: string[]): Promise<MultiVectorEmbedding[]> {
      const full = await bgeM3VllmEncode(texts, {
        baseUrl: base,
        model,
        fetchFn: o.fetchFn,
        timeoutMs: o.timeoutMs,
      });
      // The dense head obeys the same width contract as embed(); sparse/colbert ride along.
      const dense = assertVectors(
        full.map((f) => f.dense),
        o.dimensions,
        texts.length,
        { truncate: o.truncate },
      );
      return full.map((f, i) => ({ ...f, dense: dense[i] ?? f.dense }));
    },
  };
}
