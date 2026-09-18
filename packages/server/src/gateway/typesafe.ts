// THE-1078: fetch client for TypeSafe Jev — an opt-in judge PROVIDER for citation inference only,
// selected via experiential.citationInfer.judge.provider = "typesafe". This module knows nothing
// about citations; it is a minimal wire client over TypeSafe's `/v1/systemone` endpoint and its
// "Noul" question type, mirroring gateway/client.ts's retry/timeout shape so the two clients don't
// diverge for no reason. See experiential/citation-judge.ts for the adapter that calls this from
// the citation judge seam.
import { version as VERSION } from "../../package.json";

export type FetchFn = typeof fetch;

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
// THE-615's client caps total attempts at 3 (2 retries) for the same reason: a retried attempt
// burns real provider tokens against the same request, so resilience beyond that belongs to the
// caller reducing volume, not to this client trying harder.
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 5_000;
const DEFAULT_RETRY_JITTER = 0.25;
// Ceiling on ANY honored retry delay (Retry-After, retry-after-ms, or computed backoff) — a
// server-supplied delay is advice, not a blank check to make a citation pass hang.
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface TypesafeCriteria {
  true: string;
  false: string;
}

export interface TypesafeNoulRequest {
  /** Arbitrary JSON state the question is asked against. Never logged. */
  state: Record<string, unknown>;
  /** A pinned, versioned model id (e.g. "jev-1.13.0"). */
  model: string;
  instructions: string;
  criteria: TypesafeCriteria;
}

export interface TypesafeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TypesafeNoulResult {
  /** The Noul score, 0..1. */
  noul: number;
  /** The model TypeSafe actually answered with — report this, not the requested id. */
  model: string;
  usage?: TypesafeUsage;
}

/**
 * Thrown for a transport failure (non-2xx after retries exhausted, network error, timeout, or a
 * response whose shape doesn't carry what was asked for). Carries `status` and `requestId` when
 * TypeSafe's own JSON body provided them, so a caller can log a specific failure without ever
 * touching the key.
 */
export class TypesafeError extends Error {
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, opts: { status?: number; requestId?: string } = {}) {
    super(message);
    this.name = "TypesafeError";
    this.status = opts.status;
    this.requestId = opts.requestId;
    Object.setPrototypeOf(this, TypesafeError.prototype);
  }
}

export interface TypesafeClient {
  /** POST /v1/systemone with exactly one Noul question, and unwrap its answer. */
  noul(req: TypesafeNoulRequest): Promise<TypesafeNoulResult>;
}

export interface TypesafeClientOptions {
  /** Falls back to DEFAULT_BASE_URL ("https://api.typesafe.ai"). */
  baseUrl?: string;
  /** Bearer key. Never logged, never included in a thrown error's message. */
  apiKey?: string;
  fetchFn?: FetchFn;
  /** Per-ATTEMPT timeout in ms — each retry gets a FRESH window. Default 60s. */
  timeoutMs?: number;
  /** Total attempts (first try + retries). Default 3 (2 retries). */
  maxAttempts?: number;
  /** Base delay for exponential backoff, ms. Default 500, doubling, capped at retryMaxDelayMs. */
  retryBaseDelayMs?: number;
  /** Cap on a COMPUTED backoff delay (not an honored Retry-After). Default 5000ms. */
  retryMaxDelayMs?: number;
  /** Jitter fraction applied to a computed backoff delay. Default 0.25 (±25%). */
  retryJitter?: number;
  /** Delay seam for tests. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Jitter seam for tests — returns a value in [0, 1). Default Math.random. */
  randomFn?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` per RFC 9110 §10.2.3: either delay-seconds or an HTTP-date. */
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

/** Exponential backoff for the Nth attempt that just failed (1-indexed): base * 2^(N-1), capped,
 *  then jittered by ±jitter fraction. Same shape as gateway/client.ts's backoffDelayMs, with jitter
 *  added on top per this ticket's spec (0.25 default). */
function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitter: number,
  randomFn: () => number,
): number {
  const base = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const spread = base * jitter;
  // randomFn() in [0, 1) -> offset in [-spread, +spread).
  return Math.max(0, base + (randomFn() * 2 - 1) * spread);
}

interface TypesafeAnswer {
  type?: string;
  noul?: number;
}

/** A Noul call asks exactly ONE question, so the answer to unwrap is whichever single key
 *  `answers` carries back — not necessarily the literal `QUESTION_ID` this client sent, since
 *  TypeSafe echoes the id the CALLER's question named (a captured contract fixture from a
 *  differently-named question, e.g. "uses_source", still parses correctly). `undefined` when
 *  `answers` is absent or empty — the caller turns that into a typed error, never `undefined`
 *  silently threaded through as a score. */
function soleAnswer(
  answers: Record<string, TypesafeAnswer> | undefined,
): TypesafeAnswer | undefined {
  if (!answers) return undefined;
  for (const key of Object.keys(answers)) return answers[key];
  return undefined;
}

interface TypesafeResponseBody {
  model?: string;
  answers?: Record<string, TypesafeAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  request_id?: string;
}

/** The single question id this client ever asks. There is exactly one Noul per call — a citation
 *  verdict is a single yes/no-with-confidence question — so a fixed id keeps the wire body and the
 *  response-unwrap trivially paired without inventing a second identifier scheme. */
const QUESTION_ID = "q";

export function createTypesafeClient(opts: TypesafeClientOptions = {}): TypesafeClient {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = opts.apiKey;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxDelayMs = opts.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS;
  const retryJitter = opts.retryJitter ?? DEFAULT_RETRY_JITTER;
  const sleepFn = opts.sleepFn ?? realSleep;
  const randomFn = opts.randomFn ?? Math.random;

  async function noul(req: TypesafeNoulRequest): Promise<TypesafeNoulResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // A FRESH AbortController every attempt — see gateway/client.ts's post() for why a reused
      // controller would abort a retry instantly after the first attempt's own timeout fires.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Awaited<ReturnType<FetchFn>> | undefined;
      try {
        res = await fetchFn(`${base}/v1/systemone`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": `obsidian-tc/${VERSION}`,
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            // Only on a RETRY — attempt 1 carries no retry-count header at all.
            ...(attempt > 1 ? { "x-typesafe-retry-count": String(attempt - 1) } : {}),
          },
          body: JSON.stringify({
            state: req.state,
            model: req.model,
            questions: {
              [QUESTION_ID]: {
                type: "noul",
                instructions: req.instructions,
                criteria: { true: req.criteria.true, false: req.criteria.false },
              },
            },
          }),
          signal: ctrl.signal,
        });
      } catch (e) {
        // Network-level throw or our own per-attempt timeout — both transient.
        lastError =
          (e as Error).name === "AbortError"
            ? new TypesafeError("typesafe: request timed out")
            : new TypesafeError(`typesafe: request failed (${(e as Error).message ?? e})`);
      } finally {
        clearTimeout(timer);
      }

      if (res) {
        if (res.ok) {
          let body: TypesafeResponseBody;
          try {
            body = (await res.json()) as TypesafeResponseBody;
          } catch {
            throw new TypesafeError("typesafe: response was not valid JSON");
          }
          const answer = soleAnswer(body.answers);
          if (
            answer?.type !== "noul" ||
            typeof answer.noul !== "number" ||
            !Number.isFinite(answer.noul)
          ) {
            // THE SHAPE-CHANGE CONTRACT: a missing/malformed answers.<id>.noul is a typed error,
            // never `undefined` silently threaded through as a score.
            throw new TypesafeError(
              "typesafe: response is missing a well-formed answers.<id>.noul (Noul question)",
              { requestId: body.request_id },
            );
          }
          return {
            noul: answer.noul,
            model: body.model ?? req.model,
            ...(body.usage
              ? {
                  usage: {
                    inputTokens: body.usage.input_tokens ?? 0,
                    outputTokens: body.usage.output_tokens ?? 0,
                  },
                }
              : {}),
          };
        }
        let requestId: string | undefined;
        try {
          const errBody = (await res.clone().json()) as { request_id?: string };
          requestId = errBody.request_id;
        } catch {
          /* body wasn't JSON or already consumed — requestId stays undefined */
        }
        const retryAfterMs =
          res.headers.get("retry-after-ms") !== null
            ? Number(res.headers.get("retry-after-ms"))
            : parseRetryAfterMs(res.headers.get("retry-after"));
        const honoredRetryAfterMs =
          retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
            ? Math.min(retryAfterMs, MAX_RETRY_DELAY_MS)
            : null;
        lastError = new TypesafeError(`typesafe: HTTP ${res.status}`, {
          status: res.status,
          requestId,
        });
        // 401/422 are OUR request being wrong (auth, malformed body) — retrying repeats the
        // mistake. 429/529/other 5xx are transient. DELIBERATE DEVIATION from THE-615's "a bare
        // 429 with no Retry-After is not retryable" rule: TypeSafe documents a bare 429 as
        // transient ("rate limits adjusting dynamically"), unlike the self-hosted LiteLLM gateway,
        // whose 429 is a quota/config answer about OUR request. Different providers, different
        // contracts — this client honors TypeSafe's, not the gateway client's.
        const retryableStatus = res.status === 429 || res.status === 529 || res.status >= 500;
        if (!retryableStatus) throw lastError;
        if (attempt < maxAttempts) {
          const delay =
            honoredRetryAfterMs ??
            backoffDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs, retryJitter, randomFn);
          await sleepFn(delay);
          continue;
        }
        throw lastError;
      }

      if (attempt < maxAttempts) {
        await sleepFn(
          backoffDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs, retryJitter, randomFn),
        );
        continue;
      }
      throw lastError;
    }
    // Unreachable: maxAttempts >= 1, so the loop above always returns or throws on its last
    // iteration. Satisfies the compiler's control-flow analysis, not a real code path.
    throw lastError;
  }

  return { noul };
}

/**
 * Convenience wrapper matching this ticket's requested shape: one Noul question in, `{noul,
 * model, usage}` out. `createTypesafeClient(...).noul(...)` already returns exactly this shape —
 * this function exists so a caller need not know the client interface to ask one question.
 */
export async function typesafeNoul(
  client: TypesafeClient,
  input: {
    state: Record<string, unknown>;
    instructions: string;
    criteria: TypesafeCriteria;
    model: string;
  },
): Promise<TypesafeNoulResult> {
  return client.noul(input);
}
