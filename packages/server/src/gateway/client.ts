import { err, extractCauseCode, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";

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
  /** THE-617: lightweight liveness probe — GET /health, LiteLLM's own health endpoint. Single
   *  attempt, never retried (a caller uses this to decide WHETHER to attempt real work; a slow
   *  multi-attempt probe defeats that). Resolves false rather than throwing on any non-2xx,
   *  network error, or timeout — a probe callers can poll casually never throws. */
  ping(): Promise<boolean>;
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
  /** Per-ATTEMPT request timeout in ms. Each retry gets its own fresh window — this bounds one
   *  attempt, not the whole call. Default 60s. */
  timeoutMs?: number;
  /** THE-615: total attempts (the first try plus retries) for a transient failure — a
   *  network-level throw, a per-attempt timeout, an HTTP 5xx, or a 429 that carries
   *  `Retry-After`. A 4xx with no `Retry-After` (including a bare 429) is a configuration/
   *  auth/quota answer from OUR request, not the gateway having a bad moment — retrying it
   *  just repeats the same mistake, so it is never retried. See DEFAULT_MAX_ATTEMPTS for the
   *  cost rationale behind the cap. Default 3. */
  maxAttempts?: number;
  /** Base delay for the exponential backoff between attempts, in ms (attempt N, 1-indexed,
   *  waits base * 2^(N-1) before the next try, capped at retryMaxDelayMs). Ignored for a 429
   *  that carries `Retry-After` — that value wins. Default 250ms. */
  retryBaseDelayMs?: number;
  /** Cap on a computed backoff delay, in ms. Does not cap an honored `Retry-After`. Default 2000ms. */
  retryMaxDelayMs?: number;
  /** Delay seam for tests — default a real setTimeout-based wait. */
  sleepFn?: (ms: number) => Promise<void>;
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

// THE-615 — retrying a failed completion is SAFE (the gateway performs no durable write on our
// side; a re-sent /chat/completions is just another read-shaped call), but it is not FREE: each
// retried attempt burns real provider tokens/quota against the same request. Keep the cap low —
// a caller that needs more resilience than 3 tries should reduce its own call volume against an
// unhealthy gateway, not lean on this client to paper over one.
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 2_000;

/** Exponential backoff for the Nth attempt that just failed (1-indexed): base * 2^(N-1),
 *  capped. Same formula as the durable job queue's backoff() (scheduler/job-queue.ts) —
 *  deliberately, so the shape of backoff doesn't vary by subsystem for no reason. */
function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` per RFC 9110 §10.2.3: either delay-seconds or an HTTP-date. Returns null (=
 *  "not present / not honored") for anything else, which callers treat as a bare, non-retryable
 *  429. */
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
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
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxDelayMs = opts.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS;
  const sleepFn = opts.sleepFn ?? realSleep;

  async function post<T>(path: string, body: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // A FRESH AbortController every attempt. Reusing one across retries means every retry
      // after the first inherits attempt 1's signal — already fired if attempt 1 timed out —
      // and would abort before the retried request even goes out.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Awaited<ReturnType<FetchFn>> | undefined;
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
        // A network-level throw or our own per-attempt timeout — both transient by nature.
        // THE-923: cause_code (same shared unwrapper as the bridge transport and embeddings
        // client) replaces the old `cause: (e as Error).message`, which was always the
        // constant "fetch failed" string, never the actual reason.
        const causeCode = extractCauseCode(e);
        lastError =
          (e as Error).name === "AbortError"
            ? err.operationTimeout("gateway timed out")
            : new ObsidianTcError("internal", "gateway request failed", {
                ...(causeCode ? { cause_code: causeCode } : {}),
              });
      } finally {
        clearTimeout(timer);
      }

      if (res) {
        if (res.ok) return (await res.json()) as T;
        const retryAfterMs =
          res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : null;
        lastError = new ObsidianTcError("internal", `gateway returned HTTP ${res.status}`, {
          status: res.status,
        });
        // 5xx: the gateway/provider is having a bad moment — retry. 4xx (including a bare 429
        // with no Retry-After): OUR request is wrong — auth, quota, a bad model alias, a
        // malformed body — and retrying it verbatim just repeats the same mistake.
        const retryableStatus = res.status >= 500 || retryAfterMs !== null;
        if (!retryableStatus) throw lastError;
        if (attempt < maxAttempts) {
          await sleepFn(retryAfterMs ?? backoffDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs));
          continue;
        }
        throw lastError;
      }

      if (attempt < maxAttempts) {
        await sleepFn(backoffDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs));
        continue;
      }
      throw lastError;
    }
    // Unreachable: maxAttempts >= 1, so the loop above always returns or throws on its last
    // iteration. Satisfies the compiler's control-flow analysis, not a real code path.
    throw lastError;
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
    async ping() {
      // Deliberately bypasses post()'s retry loop: a health probe that itself retries defeats
      // the point (a caller polls this to decide whether to attempt real work, and a caller in
      // a poll loop is already its own retry policy).
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchFn(`${base}/health`, {
          method: "GET",
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: ctrl.signal,
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
