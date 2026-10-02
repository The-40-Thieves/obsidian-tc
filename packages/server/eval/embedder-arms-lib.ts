// Pure helpers for the embedder-arms eval (embedder-arms.ts): which arms exist, the exact text each
// embedder is given, the Gemini wire shapes, the retry schedule, recall@K, the cost arithmetic and the
// pre-registered phase verdict. No I/O, so every rule is unit-testable without a network or an index.
//
// All arms embed the SAME chunks (the chunking of the source index copy). They differ only in the
// model and in the formatting that model's documentation prescribes for asymmetric retrieval.
import { enrichChunkText } from "../src/search/chunk";
import { type GoldenQuery, normalizeSeparators } from "./metrics";
import { type CorpusVerdict, summarizePaired } from "./rerank-arms-lib";

export type ArmFamily = "gateway-bge" | "gemini-2" | "gemini-001";

export interface EmbedderArm {
  name: string;
  family: ArmFamily;
  /** Model id on its own API (`BAAI/bge-m3` on the gateway, `gemini-embedding-2` on Gemini). */
  model: string;
  dims: number;
  /** Part of the pre-registered decision family (the deployable 1024-dimension arms). */
  decisionBearing: boolean;
}

export const CONTROL_ARM = "bge-m3";

export const EMBEDDER_ARMS: readonly EmbedderArm[] = [
  {
    name: CONTROL_ARM,
    family: "gateway-bge",
    model: "BAAI/bge-m3",
    dims: 1024,
    decisionBearing: false,
  },
  {
    name: "gemini-embedding-2-1024",
    family: "gemini-2",
    model: "gemini-embedding-2",
    dims: 1024,
    decisionBearing: true,
  },
  {
    name: "gemini-embedding-001-1024",
    family: "gemini-001",
    model: "gemini-embedding-001",
    dims: 1024,
    decisionBearing: true,
  },
  // Ceiling reference at the model's native width. Not deployable at the 1024-wide schema default.
  {
    name: "gemini-embedding-2-3072",
    family: "gemini-2",
    model: "gemini-embedding-2",
    dims: 3072,
    decisionBearing: false,
  },
];

export function armByName(name: string): EmbedderArm {
  const a = EMBEDDER_ARMS.find((x) => x.name === name);
  if (!a)
    throw new Error(
      `unknown arm "${name}" (known: ${EMBEDDER_ARMS.map((x) => x.name).join(", ")})`,
    );
  return a;
}

export type Corpus = "public" | "private";

/** The env var NAME holding the key a Gemini arm may use on a corpus. The gateway's Gemini key is a
 *  free-tier key, and Google may use free-tier content to improve its products, so it is public-corpus
 *  only; a private corpus needs the key of a paid, billed project, under a different name. */
export function geminiKeyEnvName(corpus: Corpus): "GEMINI_API_KEY" | "GEMINI_API_KEY_PAID" {
  return corpus === "public" ? "GEMINI_API_KEY" : "GEMINI_API_KEY_PAID";
}

/** Resolve the key for a Gemini arm, refusing a private corpus unless a distinct paid-project key is
 *  set. Throws with names only, never a value. */
export function resolveGeminiKey(corpus: Corpus, env: Record<string, string | undefined>): string {
  const name = geminiKeyEnvName(corpus);
  const key = env[name];
  if (!key) {
    throw new Error(
      corpus === "private"
        ? `${name} is not set: the private corpus must not be sent with the free-tier ${"GEMINI_API_KEY"}; set the key of a paid, billed project under ${name}`
        : `${name} is not set`,
    );
  }
  if (corpus === "private" && key === env.GEMINI_API_KEY) {
    throw new Error(
      `${name} equals GEMINI_API_KEY (the free-tier key): refusing to send the private corpus`,
    );
  }
  return key;
}

const titleOf = (path: string): string => (path.split(/[/\\]/).pop() ?? path).replace(/\.md$/i, "");

export interface DocChunk {
  path: string;
  headings: string[];
  content: string;
}

/** The document-side text for an arm. bge-m3 and gemini-embedding-001 get the production embed text
 *  (`enrichChunkText`: title, heading breadcrumb, body). gemini-embedding-2 has no task-type field; its
 *  documentation prescribes `title: <title> | text: <body>` for retrieval documents, so the same title
 *  and breadcrumb are given in that shape. */
export function documentText(arm: EmbedderArm, c: DocChunk): string {
  if (arm.family !== "gemini-2") return enrichChunkText(c.path, c.headings, c.content);
  const body = c.headings.length > 0 ? `${c.headings.join(" — ")}\n\n${c.content}` : c.content;
  return `title: ${titleOf(c.path) || "none"} | text: ${body}`;
}

/** The query-side text. Only gemini-embedding-2 rewrites it (its prescribed `task: search result |`
 *  prefix); the others take the raw query and, for -001, a RETRIEVAL_QUERY task type. */
export function queryText(arm: EmbedderArm, q: string): string {
  return arm.family === "gemini-2" ? `task: search result | query: ${q}` : q;
}

export type EmbedKind = "document" | "query";

/** One request of a Gemini `batchEmbedContents` call (REST field names, camelCase). Each text is its
 *  own request, which is what keeps gemini-embedding-2 from aggregating a batch into one vector. */
export function geminiRequest(
  arm: EmbedderArm,
  text: string,
  kind: EmbedKind,
): Record<string, unknown> {
  return {
    model: `models/${arm.model}`,
    content: { parts: [{ text }] },
    outputDimensionality: arm.dims,
    ...(arm.family === "gemini-001"
      ? { taskType: kind === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY" }
      : {}),
  };
}

export function geminiBatchBody(
  arm: EmbedderArm,
  texts: string[],
  kind: EmbedKind,
): { requests: unknown[] } {
  return { requests: texts.map((t) => geminiRequest(arm, t, kind)) };
}

export function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n > 0 ? v.map((x) => x / n) : v;
}

export function l2norm(v: number[]): number {
  return Math.sqrt(v.reduce((a, x) => a + x * x, 0));
}

/** Validate a batch response: one vector per input, the requested width, finite numbers. Returns the
 *  vectors L2-normalized (gemini-embedding-001 truncated to a non-native width is not unit length, and
 *  normalizing an already-unit vector is a no-op). */
export function parseGeminiEmbeddings(json: unknown, expected: number, dims: number): number[][] {
  const e = (json as { embeddings?: Array<{ values?: number[] }> } | undefined)?.embeddings;
  if (!Array.isArray(e) || e.length !== expected)
    throw new Error(`expected ${expected} embeddings, got ${Array.isArray(e) ? e.length : "none"}`);
  return e.map((x, i) => {
    const v = x.values;
    if (!Array.isArray(v) || v.length !== dims || !v.every(Number.isFinite))
      throw new Error(
        `embedding ${i}: expected ${dims} finite values, got ${Array.isArray(v) ? v.length : "none"}`,
      );
    return l2normalize(v);
  });
}

export function cosine(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] as number) * (b[i] as number);
  return d / (l2norm(a) * l2norm(b));
}

/** Seconds to wait before retry `attempt` (0-based) of a 429 or 5xx: the server's Retry-After when it
 *  sent one, else exponential from 2 s, capped at 60 s. */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, 120_000);
  return Math.min(2_000 * 2 ** attempt, 60_000);
}

/** A per-day quota 429 cannot be waited out inside one run; a per-minute one can. Google names the
 *  quota in the error text (`...PerDay...`). */
export function isDailyQuota(message: string): boolean {
  return /perday|per day|daily/i.test(message);
}

/** Recall over unique result paths: the share of a query's expected notes (seed + target + bridge)
 *  found within the first `k` unique paths. Same definition as `recall_at_10` in metrics.ts, any k. */
export function recallAtK(q: GoldenQuery, resultPaths: string[], k: number): number {
  const expected = new Set([...q.seed_paths, ...q.target_paths, ...q.bridge_paths]);
  if (expected.size === 0) return 0;
  const seen = new Set<string>();
  const top: string[] = [];
  for (const raw of resultPaths) {
    const p = normalizeSeparators(raw);
    if (!seen.has(p)) {
      seen.add(p);
      top.push(p);
    }
  }
  const topSet = new Set(top.slice(0, k));
  return [...expected].filter((p) => topSet.has(p)).length / expected.size;
}

export interface Price {
  /** USD per 1M input tokens. */
  perMTokens: number;
  source: string;
}

/** Cost of embedding `tokens` input tokens at `price`. */
export function embedCostUsd(tokens: number, price: Price): number {
  return (tokens / 1_000_000) * price.perMTokens;
}

/** Cloudflare Workers AI bills `@cf/baai/bge-m3` in neurons: 1,075 neurons per 1M input tokens, at
 *  $0.011 per 1,000 neurons. */
export function neuronsToUsd(neurons: number): number {
  return (neurons / 1000) * 0.011;
}
export const BGE_M3_NEURONS_PER_M_TOKENS = 1075;

export interface RetrievalRow {
  /** arm label set, e.g. "strict" */
  labels: string;
  verdict: CorpusVerdict;
  delta: number;
  lower95: number;
}

/** The pre-registered answer to "run the private phase?", from the decision-bearing arms' verdicts on
 *  nDCG@10. YES iff some arm is a WIN on at least one label set and is neither a LOSS nor CATASTROPHIC
 *  on any label set. Anything else is NO. A public-only result never promotes a default (ADR 0007);
 *  this only decides whether a private measurement is worth paying for. */
export function privatePhaseDecision(rowsByArm: Record<string, RetrievalRow[]>): {
  run: boolean;
  reason: string;
} {
  const qualifying: string[] = [];
  for (const [arm, rows] of Object.entries(rowsByArm)) {
    const win = rows.some((r) => r.verdict === "WIN");
    const bad = rows.some((r) => r.verdict === "LOSS" || r.verdict === "CATASTROPHIC");
    if (win && !bad) qualifying.push(arm);
  }
  return qualifying.length > 0
    ? {
        run: true,
        reason: `WIN on at least one label set with no LOSS/CATASTROPHIC: ${qualifying.join(", ")}`,
      }
    : {
        run: false,
        reason:
          "no decision-bearing arm is a WIN without a LOSS/CATASTROPHIC on the other label set",
      };
}

/** Paired nDCG@10 summary of an arm against the control over the same query order. */
export function pairedAgainstControl(
  control: number[],
  arm: number[],
): ReturnType<typeof summarizePaired> {
  if (control.length !== arm.length)
    throw new Error("control and arm cover different query counts");
  return summarizePaired(control, arm);
}
