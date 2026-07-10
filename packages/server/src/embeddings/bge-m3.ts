// bge-m3 multi-representation encoder — vLLM backend (THE-388). Talks to a vLLM server started with:
//   vllm serve BAAI/bge-m3 --hf-overrides '{"architectures":["BgeM3EmbeddingModel"]}'
// producing { dense, sparse, colbert } per input:
//   - dense:   POST {base}/embeddings                    -> data[i].embedding (number[])
//   - sparse:  POST {base}/pooling  task=token_classify  -> per-token scores, paired with /tokenize
//   - colbert: POST {base}/pooling  task=token_embed     -> per-token vectors (number[][])
// The in-process ONNX backend is a separate, infra-gated follow-up; BOTH backends return this same
// shape so the storage + retrieval side (sparse.ts, colbert.ts, graph_search) is backend-agnostic.
// The /pooling + /tokenize response shapes are ASSUMPTIONS to confirm against a live vLLM server
// (none exists in CI); the parsing + token-pairing is unit-tested with a fetch mock.
import type { ColbertMatrix } from "../search/colbert";
import type { SparseVec } from "../search/sparse";
import { type FetchFn, postJson } from "./http";

export interface BgeM3Output {
  dense: number[];
  sparse: SparseVec;
  colbert: ColbertMatrix;
}

export interface BgeM3VllmOptions {
  /** vLLM OpenAI-compatible base, e.g. "http://127.0.0.1:8000/v1". */
  baseUrl: string;
  model?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

/**
 * Build a bge-m3 sparse vector from a token-classify pass: pair token ids with scores, keep positive
 * weights, and dedup a repeated token id to its MAX weight (bge-m3's lexical_weights semantics).
 * Pure — the certain core of the vLLM sparse parse.
 */
export function pairSparse(tokenIds: number[], scores: number[]): SparseVec {
  const out: SparseVec = {};
  const n = Math.min(tokenIds.length, scores.length);
  for (let i = 0; i < n; i++) {
    const id = tokenIds[i];
    const w = scores[i];
    if (id === undefined || w === undefined || w <= 0) continue;
    const key = String(id);
    const prev = out[key];
    if (prev === undefined || w > prev) out[key] = w;
  }
  return out;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}
interface PoolingResponse {
  data?: Array<{ data?: number[] | number[][] }>;
}
interface TokenizeResponse {
  tokens?: number[] | number[][];
}

const DEFAULT_MODEL = "BAAI/bge-m3";

/** Encode texts to { dense, sparse, colbert } via a vLLM bge-m3 server. */
export async function bgeM3VllmEncode(
  texts: string[],
  opts: BgeM3VllmOptions,
): Promise<BgeM3Output[]> {
  if (texts.length === 0) return [];
  const model = opts.model ?? DEFAULT_MODEL;
  const base = opts.baseUrl.replace(/\/$/, "");
  const common = { fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs, provider: "bge-m3-vllm" };

  const dense = await postJson<EmbeddingsResponse>({
    url: `${base}/embeddings`,
    body: { model, input: texts },
    ...common,
  });
  const sparse = await postJson<PoolingResponse>({
    url: `${base}/pooling`,
    body: { model, input: texts, task: "token_classify" },
    ...common,
  });
  const tok = await postJson<TokenizeResponse>({
    url: `${base}/tokenize`,
    body: { model, input: texts },
    ...common,
  });
  const colbert = await postJson<PoolingResponse>({
    url: `${base}/pooling`,
    body: { model, input: texts, task: "token_embed" },
    ...common,
  });

  const tokLists = normalizeTokenLists(tok.tokens, texts.length);
  return texts.map((_, i) => ({
    dense: dense.data?.[i]?.embedding ?? [],
    sparse: pairSparse(tokLists[i] ?? [], asScores(sparse.data?.[i]?.data)),
    colbert: asMatrix(colbert.data?.[i]?.data),
  }));
}

/** /tokenize returns number[] for a single input, number[][] for a batch. Normalise to per-input. */
function normalizeTokenLists(tokens: number[] | number[][] | undefined, count: number): number[][] {
  if (!tokens || tokens.length === 0) return Array.from({ length: count }, () => []);
  return Array.isArray(tokens[0]) ? (tokens as number[][]) : [tokens as number[]];
}

/** token_classify per-input data is one score per token (number[]); tolerate a [score] wrapper. */
function asScores(d: number[] | number[][] | undefined): number[] {
  if (!d || d.length === 0) return [];
  return Array.isArray(d[0]) ? (d as number[][]).map((row) => row[0] ?? 0) : (d as number[]);
}

/** token_embed per-input data is a per-token vector matrix (number[][]). */
function asMatrix(d: number[] | number[][] | undefined): ColbertMatrix {
  if (!d || d.length === 0) return [];
  return Array.isArray(d[0]) ? (d as number[][]) : [d as number[]];
}
