// THE-1078: the citation stage-2 judge, behind ONE seam with two adapters.
//
// Before this file, citation.ts's stage-2 loop built a gateway chat request, called `judge()`
// directly, and parsed its JSON reply inline — the only judge citation-inference could ever use
// was whatever model the gateway's `judge` role pointed at. This introduces `CitationJudge`, a
// single async function type both the existing gateway chat judge and an opt-in TypeSafe Jev
// ("Noul" question) judge implement, and a factory that builds the right one from config. The
// stage-2 loop (citation.ts) now calls ONLY the seam — it never builds a judge request or parses a
// verdict itself, for either provider.
//
// `JudgeVerdict` and `parseCitationVerdict` moved here verbatim (byte-identical behaviour) so both
// adapters share one parser; citation.ts re-exports them for any external import that still
// expects them at the old path.

import { classifyJudgeBaseUrl, judgeBaseUrlHost } from "@the-40-thieves/obsidian-tc-shared";
import { resolveApiKey } from "../embeddings/provider";
import { createTypesafeClient, type TypesafeClient, TypesafeError } from "../gateway/typesafe";
import {
  assertSourcePathsAllowed,
  type EgressFilter,
  EgressViolationError,
} from "../plane/egress-filter";
import type { GatewayRoles } from "../plane/gateway";
import { prompt } from "../plane/gateway";

export const JUDGE_SYSTEM =
  "You judge citation. Given a SOURCE chunk and a RESPONSE, decide whether the RESPONSE uses " +
  "information from the SOURCE (paraphrase counts; shared topic alone does not). Respond with " +
  'ONLY strict JSON: {"cited": true|false, "score": <number 0..1>}. No prose, no fences.';

/** The widened contract, used ONLY when `allowUncertain` is set. Kept as a separate string rather
 *  than a conditional fragment so the default prompt is byte-identical to what has always shipped:
 *  a judge prompt is model-visible input, and changing it changes model output on every call. */
export const JUDGE_SYSTEM_UNCERTAIN =
  "You judge citation. Given a SOURCE chunk and a RESPONSE, decide whether the RESPONSE uses " +
  "information from the SOURCE (paraphrase counts; shared topic alone does not). Respond with " +
  'ONLY strict JSON: {"cited": true|false|"uncertain", "score": <number 0..1>}. Answer ' +
  '"uncertain" when the evidence genuinely does not settle it — abstention is better than a ' +
  "confident guess. No prose, no fences.";

/** `true`/`false` are the judge's verdict; `"uncertain"` is its abstention, and only reachable
 *  when the caller opted in (see `allowUncertain`). Reachable only from the CHAT adapter — the
 *  TypeSafe Noul adapter never abstains (see `typesafeCitationJudge`). */
export interface JudgeVerdict {
  cited: boolean | "uncertain";
  score: number;
}

/**
 * `allowUncertain` gates the WIDER vocabulary on the parse side too, deliberately.
 *
 * A rejected parse is not free: it increments `parseFailures`, and >5% of judged rows aborts the
 * entire stamping pass (the kill switch). So the prompt and the parser have to move together — a
 * widened prompt against this parser's old `typeof v.cited !== "boolean"` check would turn every
 * abstention into a parse failure and could abort a whole run. Gating both on one flag makes that
 * pairing impossible to get half-right.
 *
 * With the flag OFF the behaviour is byte-identical to before: an `"uncertain"` reply is still a
 * parse failure, exactly as it is today.
 */
export function parseCitationVerdict(text: string, allowUncertain: boolean): JudgeVerdict | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const v = JSON.parse(stripped) as { cited?: unknown; score?: unknown };
    const score = typeof v.score === "number" && Number.isFinite(v.score) ? v.score : 0;
    const clamped = Math.max(0, Math.min(1, score));
    if (typeof v.cited === "boolean") return { cited: v.cited, score: clamped };
    if (allowUncertain && v.cited === "uncertain") return { cited: "uncertain", score: clamped };
    return null;
  } catch {
    return null;
  }
}

/** One judged (source, response) pair's outcome, discriminated the same way citation.ts's stage-2
 *  loop has always discriminated it: `unparseable` (the judge ANSWERED, unusably) vs `transport`
 *  (the judge never answered) are different faults with opposite remedies — see citation.ts's own
 *  comment on `judgeErrors` vs `parseFailures` for the THE-717 history behind that split. */
export type CitationJudgeOutcome =
  | { kind: "ok"; verdict: JudgeVerdict }
  | { kind: "unparseable" }
  | { kind: "transport" };

/**
 * The one seam citation.ts's stage-2 loop calls. `sourcePaths` is always the judged chunk's own
 * path, wrapped in an array — same convention `citation.ts` used inline before this seam existed.
 *
 * MUST NEVER reject with anything other than `EgressViolationError` — every other failure (a
 * thrown network/HTTP/timeout error from either adapter) is caught internally and reported as
 * `{kind: "transport"}`, so the fan-out in citation.ts (`runWithConcurrency`) keeps its
 * allSettled-style isolation.
 */
export type CitationJudge = (input: {
  source: string;
  response: string;
  sourcePaths: string[];
}) => Promise<CitationJudgeOutcome>;

/**
 * The gateway chat judge, unchanged in behaviour from what citation.ts built inline before this
 * seam: the EXACT SAME system prompt selection, request shape (`prompt()` + `responseFormat` +
 * `sourcePaths`), slicing (1500/4000 chars), and parse call. A byte-identity test pins this.
 */
export function chatCitationJudge(
  judge: GatewayRoles["judge"],
  opts: { judgeSystem?: string; allowUncertain?: boolean } = {},
): CitationJudge {
  const judgeSystem =
    opts.judgeSystem ?? (opts.allowUncertain ? JUDGE_SYSTEM_UNCERTAIN : JUDGE_SYSTEM);
  const allowUncertain = opts.allowUncertain === true;
  return async ({ source, response, sourcePaths }) => {
    const req = {
      ...prompt(
        judgeSystem,
        `SOURCE:\n${source.slice(0, 1500)}\n\nRESPONSE:\n${response.slice(0, 4000)}`,
      ),
      responseFormat: { type: "json_object" },
      // THE-934: the egress guard's defence-in-depth check.
      sourcePaths,
    };
    try {
      const res = await judge(req);
      const v = parseCitationVerdict(res.text, allowUncertain);
      return v === null ? { kind: "unparseable" } : { kind: "ok", verdict: v };
    } catch (e) {
      if (e instanceof EgressViolationError) throw e;
      return { kind: "transport" };
    }
  };
}

/**
 * TypeSafe Jev Noul question: "does the response use information from the source?" — a single
 * yes/no-with-confidence question, never an abstention (Noul has no third answer). `cited` is
 * `noul >= threshold`; `score` is the raw Noul. The reported `model` is always what the RESPONSE
 * says TypeSafe actually answered with, matching the gateway adapter's own convention of trusting
 * the response over the request.
 */
export function typesafeCitationJudge(
  client: TypesafeClient,
  opts: { model: string; threshold: number; filter: EgressFilter },
): CitationJudge {
  return async ({ source, response, sourcePaths }) => {
    // Checked BEFORE any request is built — a test asserts fetch is never called on refusal.
    assertSourcePathsAllowed(opts.filter, "judge", sourcePaths);
    try {
      const r = await client.noul({
        state: { source: source.slice(0, 1500), response: response.slice(0, 4000) },
        instructions:
          "Does the `response` use information from the `source`? Using information means the " +
          "response states, paraphrases, or relies on specific facts, names, numbers, steps, or " +
          "claims that appear in the source. Merely sharing a topic with the source does not count.",
        criteria: {
          true: "The response restates or relies on specific content that appears in the source, whether quoted or paraphrased.",
          false:
            "The response does not use any specific content from the source; at most it is about a similar topic.",
        },
        model: opts.model,
      });
      return { kind: "ok", verdict: { cited: r.noul >= opts.threshold, score: r.noul } };
    } catch (e) {
      if (e instanceof EgressViolationError) throw e;
      // A `TypesafeError` with `kind: "shape"` means the judge ANSWERED — a 2xx with a malformed
      // or out-of-range Noul — which is the same fault class the chat adapter's own unparseable
      // JSON reply is, and must be counted the same way (`parseFailures`, not `judgeErrors`).
      // Every other kind ("http", "network", "timeout") — and any non-TypesafeError throw — never
      // got an answer at all, and stays `transport`.
      if (e instanceof TypesafeError && e.kind === "shape") return { kind: "unparseable" };
      return { kind: "transport" };
    }
  };
}

/** The `experiential.citationInfer.judge` config block, duck-typed against
 *  retrieval.schema.ts's `CitationJudgeConfigSchema` output rather than importing it — every
 *  other doctor/experiential view in this tree (see doctor/checks.ts's `*View` interfaces) takes a
 *  structural shape instead of the shared config type, so a caller can build one from a plain
 *  object in a test without pulling in the schema package. */
export interface CitationJudgeConfig {
  provider?: "gateway" | "typesafe";
  model?: string;
  threshold?: number;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  /** THE-1084: opt-in widening of the https-unless-loopback rule on `baseUrl` to any http:// host —
   *  see retrieval.schema.ts's own doc comment. Duck-typed default `false`, matching the schema's. */
  allowPlainHttp?: boolean;
  timeoutMs?: number;
}

export interface BuildCitationJudgeDeps {
  /** The gateway's judge role, or null when no gateway is configured — same contract
   *  `InferCitationsOptions.judge` has always had. Only consulted for provider "gateway". */
  gatewayJudge?: GatewayRoles["judge"] | null;
  judgeSystem?: string;
  allowUncertain?: boolean;
  /** THE-934: egress.excludePaths, compiled. Required so the typesafe adapter's guard has
   *  something to check against — same requirement the gateway port guard has always had. */
  excludeFilter: EgressFilter;
  /** Test seam for the TypeSafe client's fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Build the `CitationJudge` both call sites (cli/commands/citation-infer.ts and
 * runtime/plane-wiring.ts) use. Provider absent or `"gateway"` reproduces exactly today's
 * behaviour: the chat adapter over `deps.gatewayJudge`, or `null` (stage-1-only mode) when no
 * gateway is configured. Provider `"typesafe"` builds the Noul adapter — and THROWS at
 * construction, never falling back to the chat judge, when `model`/`threshold` are missing or no
 * API key resolves. A silent fallback here would mean a misconfigured typesafe block quietly ran
 * the gateway judge instead, with no signal that the configured provider was never used.
 */
export function buildCitationJudge(
  config: CitationJudgeConfig | undefined,
  deps: BuildCitationJudgeDeps,
): CitationJudge | null {
  const provider = config?.provider ?? "gateway";
  if (provider === "gateway") {
    return deps.gatewayJudge
      ? chatCitationJudge(deps.gatewayJudge, {
          judgeSystem: deps.judgeSystem,
          allowUncertain: deps.allowUncertain,
        })
      : null;
  }
  if (!config?.model) {
    throw new Error(
      'experiential.citationInfer.judge: provider is "typesafe" but no model is configured — set ' +
        'judge.model to a pinned, versioned TypeSafe model id (e.g. "jev-1.13.0")',
    );
  }
  if (config.threshold === undefined) {
    throw new Error(
      'experiential.citationInfer.judge: provider is "typesafe" but no threshold is configured — ' +
        "set judge.threshold (0..1); TypeSafe thresholds are tuned per model version and have no " +
        "safe default",
    );
  }
  const apiKeyEnv = config.apiKeyEnv ?? "TYPESAFE_API_KEY";
  const key = resolveApiKey("typesafe", config.apiKey, apiKeyEnv);
  if (!key) {
    throw new Error(
      'experiential.citationInfer.judge: provider is "typesafe" but no API key was found — set ' +
        `${apiKeyEnv} (or judge.apiKey) — no fallback to the gateway judge is applied`,
    );
  }
  // THE-1084 review round 1, finding 2: this builder is duck-typed and reachable from structural
  // callers (e.g. runtime/plane-wiring.ts) that need not have gone through
  // ServerConfigSchema.parse's superRefine — so the https-unless-loopback-unless-opted-in
  // invariant is enforced HERE too, not assumed. `classifyJudgeBaseUrl` is the SAME classifier the
  // schema refine and the doctor warning call, so this can never disagree with either about what a
  // given baseUrl is. "invalid" (unparseable, or a scheme other than https/http) and "http-remote"
  // without the flag both THROW, same tone as the missing-model/threshold/key errors above — a
  // construction-time config error, never a silent accept. Only the opted-in "http-remote" case
  // gets a warning, never a throw: allowPlainHttp is an explicit operator opt-in. No key is logged
  // either way — only `judgeBaseUrlHost`'s parsed hostname.
  const effectiveBaseUrl = config.baseUrl ?? "https://api.typesafe.ai";
  const cls = classifyJudgeBaseUrl(effectiveBaseUrl);
  if (cls === "invalid") {
    throw new Error(
      'experiential.citationInfer.judge: provider is "typesafe" but judge.baseUrl is not a ' +
        'canonical "scheme://host" URL with scheme https or http — check it parses that way ' +
        "(allowPlainHttp only ever widens http:// on a non-loopback host, never any other scheme)",
    );
  }
  if (cls === "http-remote") {
    if (!config.allowPlainHttp) {
      throw new Error(
        'experiential.citationInfer.judge: provider is "typesafe" but judge.baseUrl is a ' +
          "non-loopback http:// URL and judge.allowPlainHttp is not set — this URL carries the " +
          "bearer key and vault-derived text; set judge.allowPlainHttp to explicitly opt into a " +
          "trusted plain-http path (e.g. a host-local gateway or an encrypted overlay), or use " +
          "https:// / a loopback host instead",
      );
    }
    console.warn(
      `judge.baseUrl is plain http (allowPlainHttp): the key and vault text are sent in clear to ${judgeBaseUrlHost(effectiveBaseUrl)}`,
    );
  }
  const client = createTypesafeClient({
    baseUrl: config.baseUrl,
    apiKey: key,
    timeoutMs: config.timeoutMs,
    fetchFn: deps.fetchFn,
  });
  return typesafeCitationJudge(client, {
    model: config.model,
    threshold: config.threshold,
    filter: deps.excludeFilter,
  });
}
