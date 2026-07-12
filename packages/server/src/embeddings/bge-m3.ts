// bge-m3 multi-representation encoder — vLLM backend (THE-388). Talks to a vLLM server started with:
//   vllm serve BAAI/bge-m3 --runner pooling
// producing { dense, sparse, colbert } per input:
//   - dense:   POST {base}/embeddings                    -> data[i].embedding (number[])
//   - sparse:  POST {root}/pooling  task=token_classify  -> per-token scores, paired with /tokenize
//   - colbert: POST {root}/pooling  task=token_embed     -> per-token vectors (number[][])
//
// LIVE-VERIFIED SHAPES (2026-07-11, vllm/vllm-openai:latest — THE-395 findings):
//   - Only the OpenAI-compatible surface is namespaced under /v1; /pooling and /tokenize live at
//     the server ROOT (the /v1-prefixed forms 404).
//   - /tokenize takes { model, prompt } (a single string per call), returning { tokens: number[] }.
//   - The pooling task is configured PER SERVER (--pooler-config.task); a request naming a
//     different task is rejected, and token_classify is not in the supported set at all
//     (['embed', 'token_embed']). So a single server cannot produce all three heads today:
//     the sparse and ColBERT heads DEGRADE to empty when their task is unavailable (memoized per
//     server+task so a long reindex doesn't re-pay the failing round-trip), and the indexer skips
//     storing empty heads. The in-process ONNX backend remains the path to true lexical_weights.
import type { ColbertMatrix } from "../search/colbert";
import type { SparseVec } from "../search/sparse";
import { type FetchFn, postJson } from "./http";
import type { MultiVectorEmbedding } from "./provider";

/** bge-m3's three heads per input — the provider-layer MultiVectorEmbedding shape. */
export type BgeM3Output = MultiVectorEmbedding;

export interface BgeM3VllmOptions {
  /** vLLM OpenAI-compatible base, e.g. "http://127.0.0.1:8000/v1". */
  baseUrl: string;
  model?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

// XLM-RoBERTa special token ids: <s>=0, <pad>=1, </s>=2, <unk>=3. FlagEmbedding's
// _process_token_weights drops these BEFORE pooling — without the filter, <s> carries
// content-term-magnitude weight on ~every input, so every query matches every document
// on the cls key and the sparse ranking degrades (measured on the live index: cls present
// in 99.7% of stored vectors at mean weight 0.17, ranking among the top content terms).
const XLMR_SPECIAL_IDS: ReadonlySet<number> = new Set([0, 1, 2, 3]);

/**
 * Align /tokenize ids to token_classify scores. vLLM's BgeM3 pooler strips BOS/EOS from the
 * SCORES while /tokenize returns the full id list: equal lengths pair directly; a 2-short
 * scores list pairs against tokens.slice(1, -1); any other mismatch returns null so the
 * caller degrades the head to empty. NEVER positionally truncate a mismatch — that shifts
 * every weight onto the wrong token id and the corrupted vector is indistinguishable from
 * a valid one downstream (this exact defect invalidated the first THE-403 sparse index).
 */
export function alignTokensToScores(tokens: number[], scores: number[]): number[] | null {
  if (scores.length === tokens.length) return tokens;
  if (scores.length === tokens.length - 2) return tokens.slice(1, -1);
  return null;
}

/**
 * Build a bge-m3 sparse vector from a token-classify pass: drop special tokens, keep positive
 * weights, and dedup a repeated token id to its MAX weight (FlagEmbedding lexical_weights
 * semantics). Pure — the certain core of the vLLM sparse parse.
 */
export function pairSparse(tokenIds: number[], scores: number[]): SparseVec {
  const out: SparseVec = {};
  const n = Math.min(tokenIds.length, scores.length);
  for (let i = 0; i < n; i++) {
    const id = tokenIds[i];
    const w = scores[i];
    if (id === undefined || w === undefined || w <= 0 || XLMR_SPECIAL_IDS.has(id)) continue;
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

// A server that rejected a pooling task keeps rejecting it — remember per {root, task} so a
// reconcile's thousands of sub-batches don't each re-pay the failing round-trip.
const unsupportedTasks = new Set<string>();

/** Encode texts to { dense, sparse, colbert } via a vLLM bge-m3 server. Heads whose pooling task
 *  the server does not expose come back EMPTY ({} / []) rather than failing the encode. */
export async function bgeM3VllmEncode(
  texts: string[],
  opts: BgeM3VllmOptions,
): Promise<BgeM3Output[]> {
  if (texts.length === 0) return [];
  const model = opts.model ?? DEFAULT_MODEL;
  const base = opts.baseUrl.replace(/\/$/, "");
  const root = base.replace(/\/v1$/, "");
  const common = { fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs, provider: "bge-m3-vllm" };

  const dense = await postJson<EmbeddingsResponse>({
    url: `${base}/embeddings`,
    body: { model, input: texts },
    ...common,
  });

  let sparses: SparseVec[] = texts.map(() => ({}));
  if (!unsupportedTasks.has(`${root}:token_classify`)) {
    try {
      const sparse = await postJson<PoolingResponse>({
        url: `${root}/pooling`,
        body: { model, input: texts, task: "token_classify" },
        ...common,
      });
      const tokLists: number[][] = [];
      for (const t of texts) {
        const tok = await postJson<TokenizeResponse>({
          url: `${root}/tokenize`,
          body: { model, prompt: t },
          ...common,
        });
        tokLists.push(Array.isArray(tok.tokens) ? (tok.tokens as number[]) : []);
      }
      sparses = texts.map((_, i) => {
        const toks = tokLists[i] ?? [];
        const sc = asScores(sparse.data?.[i]?.data);
        const aligned = alignTokensToScores(toks, sc);
        return aligned ? pairSparse(aligned, sc) : {};
      });
    } catch {
      unsupportedTasks.add(`${root}:token_classify`);
    }
  }

  let colberts: ColbertMatrix[] = texts.map(() => []);
  if (!unsupportedTasks.has(`${root}:token_embed`)) {
    try {
      const colbert = await postJson<PoolingResponse>({
        url: `${root}/pooling`,
        body: { model, input: texts, task: "token_embed" },
        ...common,
      });
      colberts = texts.map((_, i) => asMatrix(colbert.data?.[i]?.data));
    } catch {
      unsupportedTasks.add(`${root}:token_embed`);
    }
  }

  return texts.map((_, i) => ({
    dense: dense.data?.[i]?.embedding ?? [],
    sparse: sparses[i] ?? {},
    colbert: colberts[i] ?? [],
  }));
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
