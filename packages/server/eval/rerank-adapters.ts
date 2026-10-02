// Per-provider rerank adapters for the reranker-arms eval. They live in the harness, not src/:
// only OpenRouter speaks the Cohere dialect the production `cohere-compatible` provider already
// handles, so it reuses that provider unchanged; the other three vendors each have their own wire
// shape and a production entry for them is a product decision this eval does not make.
//
// Every adapter is a plain `Reranker` (query, documents, topN) => hits, the exact port the product
// uses, so what is measured here is what a configured provider would return. Keys are read from the
// environment by NAME and never logged; an error carries the HTTP status, never the URL or a header.
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { cohereCompatibleReranker } from "../src/providers/http-rerank";
import type { Reranker } from "../src/search/rerank";

export interface AdapterEnv {
  [name: string]: string | undefined;
}

export class RerankHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`HTTP ${status}`);
  }
}

/** POST JSON and return the parsed body; throws RerankHttpError (status only) on a non-2xx. */
async function postJsonBody<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after"));
      throw new RerankHttpError(res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function need(env: AdapterEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set (the arm is skipped when its key is absent)`);
  return v;
}

/** Cloudflare Workers AI `@cf/baai/bge-reranker-base` (512-token input, sigmoid scores in 0..1).
 *  Called directly, so the caller owns the account's daily neuron budget. */
export function cloudflareBgeReranker(env: AdapterEnv, timeoutMs = 60_000): Reranker {
  const account = need(env, "CLOUDFLARE_ACCOUNT_ID");
  const token = need(env, "CLOUDFLARE_API_TOKEN");
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/baai/bge-reranker-base`;
  return async (query, documents, topN) => {
    const r = await postJsonBody<{
      success?: boolean;
      result?: { response?: Array<{ id: number; score: number }> };
    }>(
      url,
      { authorization: `Bearer ${token}` },
      {
        query,
        contexts: documents.map((text) => ({ text })),
        top_k: topN > 0 ? topN : documents.length,
      },
      timeoutMs,
    );
    return (r.result?.response ?? []).map((h) => ({ index: h.id, relevanceScore: h.score }));
  };
}

/** DeepInfra `Qwen/Qwen3-Reranker-0.6B`: the endpoint pairs queries[i] with documents[i], so the
 *  one query is repeated once per document. Zero-retention per DeepInfra's published policy. */
export function deepInfraQwen3Reranker(env: AdapterEnv, timeoutMs = 90_000): Reranker {
  const key = need(env, "DEEPINFRA_API_KEY");
  const url = "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-0.6B";
  return async (query, documents) => {
    const r = await postJsonBody<{ scores?: number[] }>(
      url,
      { authorization: `bearer ${key}` },
      { queries: documents.map(() => query), documents },
      timeoutMs,
    );
    return (r.scores ?? []).map((score, index) => ({ index, relevanceScore: score }));
  };
}

/** NVIDIA API Catalog `llama-nemotron-rerank-vl-1b-v2` (logits; ranking order is what matters). */
export function nvidiaNemotronReranker(env: AdapterEnv, timeoutMs = 90_000): Reranker {
  const key = need(env, "NVIDIA_NIM_API_KEY");
  const url =
    "https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-nemotron-rerank-vl-1b-v2/reranking";
  return async (query, documents) => {
    const r = await postJsonBody<{ rankings?: Array<{ index: number; logit: number }> }>(
      url,
      { authorization: `Bearer ${key}` },
      {
        model: "nvidia/llama-nemotron-rerank-vl-1b-v2",
        query: { text: query },
        passages: documents.map((text) => ({ text })),
      },
      timeoutMs,
    );
    return (r.rankings ?? []).map((h) => ({ index: h.index, relevanceScore: h.logit }));
  };
}

/** OpenRouter `/rerank` is Cohere-shaped: the production `cohere-compatible` provider, unchanged. */
export function openRouterReranker(env: AdapterEnv, model: string, timeoutMs = 90_000): Reranker {
  return cohereCompatibleReranker({
    baseUrl: "https://openrouter.ai/api/v1",
    model,
    apiKey: need(env, "OPENROUTER_API_KEY"),
    timeoutMs,
  });
}

export interface ThrottleOpts {
  /** Minimum gap between two calls started by this wrapper. */
  minIntervalMs: number;
  /** Attempts per call (first try included) before the error is rethrown. */
  attempts?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const statusOf = (e: unknown): number | undefined => {
  if (e instanceof RerankHttpError) return e.status;
  // cohere-compatible throws the product's typed error whose message is "HTTP <status>".
  const m = /HTTP (\d{3})/.exec(String((e as Error)?.message ?? ""));
  return m ? Number(m[1]) : undefined;
};

/** A reranker that records the wall time of its last SUCCESSFUL provider call (retries and the RPM
 *  spacing sleeps excluded), so latency is the provider's, not the throttle's. */
export type TimedReranker = Reranker & { lastMs: number };

/** Spaces calls (RPM limits) and retries 429/5xx and timeouts with backoff. A 4xx other than 429 is a
 *  malformed request: retrying would only burn budget, so it is rethrown at once. */
export function throttled(inner: Reranker, o: ThrottleOpts): TimedReranker {
  const attempts = o.attempts ?? 4;
  let next = 0;
  const fn: TimedReranker = Object.assign(
    async (query: string, documents: string[], topN: number, sourcePaths: string[]) => {
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        const wait = next - Date.now();
        if (wait > 0) await sleep(wait);
        next = Date.now() + o.minIntervalMs;
        try {
          const t0 = performance.now();
          const hits = await inner(query, documents, topN, sourcePaths);
          fn.lastMs = performance.now() - t0;
          return hits;
        } catch (e) {
          last = e;
          const s = statusOf(e);
          const retryable = s === undefined || s === 429 || s >= 500;
          if (!retryable || i === attempts - 1) throw e;
          const ra = e instanceof RerankHttpError ? e.retryAfterMs : undefined;
          await sleep(ra ?? Math.min(60_000, 2_000 * 2 ** i));
        }
      }
      throw last;
    },
    { lastMs: 0 },
  );
  return fn;
}

export const ARMS = [
  "cf-bge-reranker-base",
  "deepinfra-qwen3-reranker-0.6b",
  "nvidia-nemotron-rerank-vl-1b",
  "openrouter-nemotron-rerank-vl-1b-free",
  "local-minilm",
  "local-bge-reranker-v2-m3",
] as const;
export type ArmName = (typeof ARMS)[number];

/** Arms whose provider's published terms permit using submitted text to improve its products. Their
 *  candidate text may only be the PUBLIC corpus. NVIDIA's API Catalog trial terms (section 3.3)
 *  collect User Content "to improve NVIDIA products and services, including AI models", and the
 *  OpenRouter free model is served by that same NVIDIA endpoint. */
export const PUBLIC_ONLY_ARMS: ReadonlySet<ArmName> = new Set([
  "nvidia-nemotron-rerank-vl-1b",
  "openrouter-nemotron-rerank-vl-1b-free",
]);

/** Build the (throttled) reranker for an arm. `local-minilm` loads reranker-local lazily. */
export async function buildArm(name: ArmName, env: AdapterEnv): Promise<TimedReranker> {
  switch (name) {
    case "cf-bge-reranker-base":
      return throttled(cloudflareBgeReranker(env), { minIntervalMs: 250 });
    case "deepinfra-qwen3-reranker-0.6b":
      return throttled(deepInfraQwen3Reranker(env), { minIntervalMs: 250 });
    case "nvidia-nemotron-rerank-vl-1b":
      return throttled(nvidiaNemotronReranker(env), { minIntervalMs: 1_600 });
    case "openrouter-nemotron-rerank-vl-1b-free":
      // 20 requests per minute on the free tier: one call every 3.2 s is the ceiling.
      return throttled(openRouterReranker(env, "nvidia/llama-nemotron-rerank-vl-1b-v2:free"), {
        minIntervalMs: 3_300,
      });
    case "local-minilm": {
      const { createReranker } = await import("../../reranker-local/src/index");
      return timedLocal(createReranker({}));
    }
    case "local-bge-reranker-v2-m3":
      return timedLocal(await bgeV2M3Local());
  }
}

function timedLocal(r: Reranker): TimedReranker {
  const fn: TimedReranker = Object.assign(
    async (q: string, docs: string[], topN: number, paths: string[]) => {
      const t0 = performance.now();
      const hits = await r(q, docs, topN, paths);
      fn.lastMs = performance.now() - t0;
      return hits;
    },
    { lastMs: 0 },
  );
  return fn;
}

interface TransformersJs {
  AutoTokenizer: { from_pretrained(id: string): Promise<(q: string[], o: object) => object> };
  AutoModelForSequenceClassification: {
    from_pretrained(
      id: string,
      o: object,
    ): Promise<(inputs: object) => Promise<{ logits: { data: ArrayLike<number> } }>>;
  };
}

/** `BAAI/bge-reranker-v2-m3` as an int8 ONNX export (`onnx-community`), on CPU, through the same
 *  Transformers.js runtime `reranker-local` uses, loaded from that package's own install (it is
 *  deliberately not a root dependency). 8 passages per forward pass bounds memory at 512 tokens each.
 *  The intra-op thread count is ALL cores: a best case, so a verdict that it is too slow is robust. */
async function bgeV2M3Local(batch = 8): Promise<Reranker> {
  const tf = (await import(
    join(import.meta.dirname, "../../reranker-local/node_modules/@huggingface/transformers")
  )) as TransformersJs;
  const id = "onnx-community/bge-reranker-v2-m3-ONNX";
  const tokenizer = await tf.AutoTokenizer.from_pretrained(id);
  const model = await tf.AutoModelForSequenceClassification.from_pretrained(id, {
    dtype: "int8",
    session_options: { intraOpNumThreads: availableParallelism(), interOpNumThreads: 1 },
  });
  return async (query, documents, topN) => {
    const scores: number[] = [];
    for (let i = 0; i < documents.length; i += batch) {
      const docs = documents.slice(i, i + batch);
      const inputs = tokenizer(
        docs.map(() => query),
        { text_pair: docs, padding: true, truncation: true, max_length: 512 },
      );
      scores.push(...Array.from((await model(inputs)).logits.data));
    }
    const hits = scores.map((relevanceScore, index) => ({ index, relevanceScore }));
    hits.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return topN > 0 ? hits.slice(0, topN) : hits;
  };
}
