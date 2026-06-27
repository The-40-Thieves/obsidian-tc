import { err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";

export type GatewayRole = "extract" | "synthesize" | "judge";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Pass-through OpenAI `response_format`, e.g. `{ type: "json_object" }`. */
  responseFormat?: Record<string, unknown>;
}

export interface CompletionResult {
  /** Assistant message text from the first choice. */
  text: string;
  /** Resolved provider:model the gateway actually used — persist into atom attestation. */
  model: string;
  finishReason?: string;
}

export interface RerankHit {
  index: number;
  relevanceScore: number;
}

export interface RerankRequest {
  query: string;
  documents: string[];
  topN?: number;
}

export interface RerankResult {
  results: RerankHit[];
  model: string;
}

/**
 * The single generative seam for the converged engine. The engine speaks roles, never
 * providers: it calls extract / synthesize / judge, and the self-hosted LiteLLM gateway
 * binds each role to a concrete model (config, not code). rerank is the D1 Cohere-compatible
 * passthrough (rerank-v3.5 quality, no SDK in the tree). No provider SDKs, no keys in the tree.
 */
export interface GatewayClient {
  extract(req: CompletionRequest): Promise<CompletionResult>;
  synthesize(req: CompletionRequest): Promise<CompletionResult>;
  judge(req: CompletionRequest): Promise<CompletionResult>;
  rerank(req: RerankRequest): Promise<RerankResult>;
}

export type FetchFn = typeof fetch;

export interface GatewayClientOptions {
  /** Gateway base URL; falls back to OBSIDIAN_TC_GATEWAY_URL. */
  baseUrl?: string;
  /** Optional bearer (LiteLLM master/virtual key); falls back to OBSIDIAN_TC_GATEWAY_TOKEN. Never logged. */
  token?: string;
  /** Map a role to a concrete gateway model alias. Default: the role name itself. */
  models?: Partial<Record<GatewayRole, string>>;
  /** Model alias for the rerank passthrough. Default: "rerank". */
  rerankModel?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

/** Prefer the explicit URL, then OBSIDIAN_TC_GATEWAY_URL. Undefined if neither is set. */
export function resolveGatewayUrl(configUrl?: string): string | undefined {
  if (configUrl && configUrl.length > 0) return configUrl;
  const env = process.env.OBSIDIAN_TC_GATEWAY_URL;
  return env && env.length > 0 ? env : undefined;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
}

interface RerankResponse {
  model?: string;
  results?: Array<{ index: number; relevance_score: number }>;
}

export function createGatewayClient(opts: GatewayClientOptions = {}): GatewayClient {
  const baseUrl = resolveGatewayUrl(opts.baseUrl);
  if (!baseUrl) {
    throw err.validation("gateway base URL not configured", {
      hint: "set OBSIDIAN_TC_GATEWAY_URL or pass opts.baseUrl",
    });
  }
  const base = baseUrl.replace(/\/+$/, "");
  const token = opts.token ?? process.env.OBSIDIAN_TC_GATEWAY_TOKEN;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw err.operationTimeout("gateway timed out");
      throw new ObsidianTcError("internal", "gateway request failed", {
        cause: (e as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new ObsidianTcError("internal", `gateway returned HTTP ${res.status}`, {
        status: res.status,
      });
    }
    return (await res.json()) as T;
  }

  async function complete(role: GatewayRole, req: CompletionRequest): Promise<CompletionResult> {
    const model = opts.models?.[role] ?? role;
    const payload = await post<ChatCompletionResponse>("/chat/completions", {
      model,
      messages: req.messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
    });
    const choice = payload.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      model: payload.model ?? model,
      ...(choice?.finish_reason !== undefined ? { finishReason: choice.finish_reason } : {}),
    };
  }

  return {
    extract: (req) => complete("extract", req),
    synthesize: (req) => complete("synthesize", req),
    judge: (req) => complete("judge", req),
    async rerank(req) {
      const model = opts.rerankModel ?? "rerank";
      const payload = await post<RerankResponse>("/rerank", {
        model,
        query: req.query,
        documents: req.documents,
        ...(req.topN !== undefined ? { top_n: req.topN } : {}),
      });
      return {
        results: (payload.results ?? []).map((r) => ({
          index: r.index,
          relevanceScore: r.relevance_score,
        })),
        model: payload.model ?? model,
      };
    },
  };
}
