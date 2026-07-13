// ModelClient.embed adapter for a Hugging Face Text Embeddings Inference (TEI) server — the required
// dense stream (Qwen3). TEI applies the served model's own pooling (last-token for Qwen3); its
// OpenAI-compatible /v1/embeddings endpoint returns L2-normalised vectors plus the resolved model id.
// The query-side Instruct prefix stays on the TS config seam (queryPrefix), NOT here: this adapter
// embeds the texts it is handed. Revision provenance is read from GET /info when reachable, else it
// falls back to the config-pinned revision. (TEI's native prompt_name instruction path — via /embed —
// is a later option; today instruction is applied upstream.)
import { type FetchFn, postJson } from "../embeddings/http";
import { assertVectors } from "../embeddings/provider";
import type { EmbedRequest, EmbedResult, ModelClient } from "./ports";

export interface TeiClientOptions {
  /** TEI base URL WITHOUT a /v1 suffix, e.g. "http://127.0.0.1:8080". */
  baseUrl: string;
  /** Expected embedding width. Validates the server matches; drives MRL truncation when `truncate`. */
  dimensions: number;
  /** Config-pinned model id / revision; provenance fallback when /info is unreachable. */
  model?: string;
  revision?: string;
  /** Pooling the served model uses, recorded in the manifest. Default "last-token" (Qwen3). */
  pooling?: string;
  /** THE-387: Matryoshka truncation of a wider native output down to `dimensions`. */
  truncate?: boolean;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

interface TeiEmbeddingsResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
}
interface TeiInfo {
  model_id?: string;
  model_sha?: string;
}

export function teiModelClient(opts: TeiClientOptions): ModelClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const pooling = opts.pooling ?? "last-token";
  let infoCache: TeiInfo | undefined;
  let infoFetched = false;

  // Best-effort provenance: GET /info once for the served model id + revision (model_sha). A failure
  // never breaks embed — provenance degrades to the config-pinned values.
  async function info(): Promise<TeiInfo | undefined> {
    if (infoFetched) return infoCache;
    infoFetched = true;
    try {
      const res = await (opts.fetchFn ?? fetch)(`${base}/info`, { method: "GET" });
      if (res.ok) infoCache = (await res.json()) as TeiInfo;
    } catch {
      /* provenance is best-effort; fall back to config */
    }
    return infoCache;
  }

  async function meta(respModel?: string): Promise<{ model: string; revision: string }> {
    const i = await info();
    return {
      model: i?.model_id ?? respModel ?? opts.model ?? "tei",
      revision: i?.model_sha ?? opts.revision ?? "unknown",
    };
  }

  return {
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      if (req.texts.length === 0) {
        return {
          ...(await meta()),
          vectors: [],
          dimensions: opts.dimensions,
          pooling,
          normalized: true,
        };
      }
      const resp = await postJson<TeiEmbeddingsResponse>({
        url: `${base}/v1/embeddings`,
        body: { input: req.texts, model: opts.model ?? "tei" },
        fetchFn: opts.fetchFn,
        timeoutMs: opts.timeoutMs,
        provider: "tei",
      });
      // TEI returns one {embedding, index} per input; re-order by index before validating.
      const rows = (resp.data ?? [])
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.embedding ?? []);
      const vectors = assertVectors(rows, opts.dimensions, req.texts.length, {
        truncate: opts.truncate,
      });
      return {
        ...(await meta(resp.model)),
        vectors,
        dimensions: opts.dimensions,
        pooling,
        normalized: true,
      };
    },
  };
}
