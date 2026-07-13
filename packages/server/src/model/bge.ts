// ModelClient adapter for the Python BGE-M3 service (services/bge-m3-service) - the multi-vector
// stream. BGE-M3 emits three aligned heads per input: a dense [CLS] vector, learned-sparse lexical
// weights, and a ColBERT per-token matrix. The service returns all three TOGETHER from one
// /v1/encode call (token ids and their weights in the same response), so the caller never has to
// realign a separate /pooling + /tokenize round-trip. Dense here is EVAL-ONLY: the required dense
// retrieval stream is Qwen3 via tei.ts; the composition root (compose.ts) routes embed() to Qwen and
// embedFull() here. Provenance (model + revision) is read straight off the encode response, which the
// service stamps from the pinned model revision - no best-effort /info call needed.
import { type FetchFn, postJson } from "../embeddings/http";
import type { MultiVectorEmbedding } from "../embeddings/provider";
import { assertVectors } from "../embeddings/provider";
import type { SparseVec } from "../search/sparse";
import type {
  EmbedFullResult,
  EmbedRequest,
  EmbedResult,
  ModelClient,
  RerankRequest,
  RerankResult,
} from "./ports";

export interface BgeClientOptions {
  /** BGE-M3 service base URL WITHOUT a /v1 suffix, e.g. "http://127.0.0.1:8002". */
  baseUrl: string;
  /** Dense head width (bge-m3 = 1024). Validates the server matches; drives MRL truncation. */
  dimensions: number;
  /** Bearer token; the service is loopback-bound but still requires auth. Omit only for a fake fetch. */
  authToken?: string;
  /** Config-pinned model id / revision; provenance fallback for the empty-input short-circuit. */
  model?: string;
  revision?: string;
  /** THE-387: Matryoshka truncation of the dense head down to `dimensions`. */
  truncate?: boolean;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

type EncodeOutput = "dense" | "sparse" | "colbert";
interface EncodeSparse {
  token_ids?: number[];
  weights?: number[];
}
interface EncodeItem {
  dense?: number[];
  sparse?: EncodeSparse;
  colbert?: { vectors?: number[][] };
}
interface EncodeResponse {
  model?: string;
  revision?: string;
  items?: EncodeItem[];
}

interface RerankWire {
  model?: string;
  results?: Array<{ index: number; relevance_score: number }>;
}

/** Zip the service's parallel {token_ids, weights} into the token-id -> weight map SparseVec is. The
 *  two arrays are emitted aligned by the service; a length mismatch means a corrupt response, so we
 *  stop at the shorter of the two rather than pair a weight with the wrong token. */
function toSparseVec(s: EncodeSparse | undefined): SparseVec {
  const ids = s?.token_ids ?? [];
  const weights = s?.weights ?? [];
  const out: SparseVec = {};
  const n = Math.min(ids.length, weights.length);
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const w = weights[i];
    if (id !== undefined && w !== undefined) out[String(id)] = w;
  }
  return out;
}

export function bgeModelClient(opts: BgeClientOptions): ModelClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers = opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : undefined;

  async function encode(texts: string[], outputs: EncodeOutput[]): Promise<EncodeResponse> {
    return postJson<EncodeResponse>({
      url: `${base}/v1/encode`,
      body: { input: texts, outputs, model: opts.model },
      headers,
      fetchFn: opts.fetchFn,
      timeoutMs: opts.timeoutMs,
      provider: "bge-m3",
    });
  }

  function meta(resp?: EncodeResponse): { model: string; revision: string } {
    return {
      model: resp?.model ?? opts.model ?? "bge-m3",
      revision: resp?.revision ?? opts.revision ?? "unknown",
    };
  }

  return {
    // Dense-only encode (eval-only stream). Mirrors tei.ts so the golden-set harness can A/B BGE dense
    // against Qwen through the same ModelClient shape.
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      if (req.texts.length === 0) {
        return {
          ...meta(),
          vectors: [],
          dimensions: opts.dimensions,
          pooling: "cls",
          normalized: true,
        };
      }
      const resp = await encode(req.texts, ["dense"]);
      const rows = (resp.items ?? []).map((it) => it.dense ?? []);
      const vectors = assertVectors(rows, opts.dimensions, req.texts.length, {
        truncate: opts.truncate,
      });
      return {
        ...meta(resp),
        vectors,
        dimensions: opts.dimensions,
        pooling: "cls",
        normalized: true,
      };
    },

    // The multi-vector stream: dense + sparse + ColBERT, aligned per input. A head the service was not
    // asked for (or cannot produce) comes back empty ({} / []) rather than failing the encode.
    async embedFull(req: EmbedRequest): Promise<EmbedFullResult> {
      if (req.texts.length === 0) return { ...meta(), items: [] };
      const resp = await encode(req.texts, ["dense", "sparse", "colbert"]);
      const items: MultiVectorEmbedding[] = (resp.items ?? []).map((it) => ({
        dense: it.dense ?? [],
        sparse: toSparseVec(it.sparse),
        colbert: it.colbert?.vectors ?? [],
      }));
      return { ...meta(resp), items };
    },

    // Cross-encoder rerank via the service's /v1/rerank (bge-reranker-v2-m3). A retrieval model,
    // so it lives on ModelClient.rerank; composeModelClient routes rerank here.
    async rerank(req: RerankRequest): Promise<RerankResult> {
      const resp = await postJson<RerankWire>({
        url: `${base}/v1/rerank`,
        body: { query: req.query, documents: req.documents, top_n: req.topN },
        headers,
        fetchFn: opts.fetchFn,
        timeoutMs: opts.timeoutMs,
        provider: "bge-reranker",
      });
      return {
        model: resp.model ?? "bge-reranker-v2-m3",
        results: (resp.results ?? []).map((r) => ({
          index: r.index,
          relevanceScore: r.relevance_score,
        })),
      };
    },
  };
}
