// Builds the TypeSafe client for a judge block: one construction path for every consumer
// (experiential.citationInfer.judge and wikiJudge), so the model / threshold / key / baseUrl
// rules cannot drift between them. The config-load schema enforces the same rules through
// typesafeJudgeIssues (shared/net-host.ts); this enforces them again because the callers are
// duck-typed and reachable without ServerConfigSchema.parse. Nothing here falls back to another
// provider: a misconfigured block throws, and the caller decides what "no judge" means.
import { classifyJudgeBaseUrl, judgeBaseUrlHost } from "@the-40-thieves/obsidian-tc-shared";
import { resolveApiKey } from "../embeddings/provider";
import { createTypesafeClient, type TypesafeClient } from "./typesafe";

export interface TypesafeJudgeClientConfig {
  model?: string | undefined;
  threshold?: number | undefined;
  apiKey?: string | undefined;
  apiKeyEnv?: string | undefined;
  baseUrl?: string | undefined;
  /** Widens the https-unless-loopback rule on `baseUrl` to any http:// host. */
  allowPlainHttp?: boolean | undefined;
  timeoutMs?: number | undefined;
}

export interface TypesafeJudgeClientNames {
  /** Config path named in every error ("experiential.citationInfer.judge", "wikiJudge"). */
  label: string;
  /** Field prefix the messages point the operator at ("judge", "wikiJudge"). */
  field: string;
  /** Set when the block also accepts an inline key, so the missing-key message can name it. */
  inlineKeyField?: string;
}

export interface TypesafeJudgeClient {
  client: TypesafeClient;
  model: string;
  threshold: number;
}

/** @throws when the model or threshold is missing, no key resolves, or baseUrl is not https (or
 *  loopback, or opted in with allowPlainHttp). Warns, never throws, for an opted-in plain http. */
export function buildTypesafeJudgeClient(
  config: TypesafeJudgeClientConfig | undefined,
  names: TypesafeJudgeClientNames,
  fetchFn?: typeof fetch,
): TypesafeJudgeClient {
  const { label, field } = names;
  if (!config?.model) {
    throw new Error(
      `${label}: provider is "typesafe" but no model is configured — set ` +
        `${field}.model to a pinned, versioned TypeSafe model id (e.g. "jev-1.13.0")`,
    );
  }
  if (config.threshold === undefined) {
    throw new Error(
      `${label}: provider is "typesafe" but no threshold is configured — ` +
        `set ${field}.threshold (0..1); TypeSafe thresholds are tuned per model version and have no ` +
        "safe default",
    );
  }
  const apiKeyEnv = config.apiKeyEnv ?? "TYPESAFE_API_KEY";
  const key = resolveApiKey("typesafe", config.apiKey, apiKeyEnv);
  if (!key) {
    throw new Error(
      `${label}: provider is "typesafe" but no API key was found — set ` +
        `${apiKeyEnv}${names.inlineKeyField ? ` (or ${names.inlineKeyField})` : ""} — no fallback to the gateway judge is applied`,
    );
  }
  // The same classifier the schema refine and the doctor warning call, so none can disagree about
  // what a given baseUrl is. "invalid" and an un-opted-in "http-remote" throw; the opted-in
  // "http-remote" gets a warning naming only the parsed hostname, never the key.
  const effectiveBaseUrl = config.baseUrl ?? "https://api.typesafe.ai";
  const cls = classifyJudgeBaseUrl(effectiveBaseUrl);
  if (cls === "invalid") {
    throw new Error(
      `${label}: provider is "typesafe" but ${field}.baseUrl is not a ` +
        'canonical "scheme://host" URL with scheme https or http — check it parses that way ' +
        "(allowPlainHttp only ever widens http:// on a non-loopback host, never any other scheme)",
    );
  }
  if (cls === "http-remote") {
    if (!config.allowPlainHttp) {
      throw new Error(
        `${label}: provider is "typesafe" but ${field}.baseUrl is a ` +
          `non-loopback http:// URL and ${field}.allowPlainHttp is not set — this URL carries the ` +
          "bearer key and vault-derived text; set " +
          `${field}.allowPlainHttp to explicitly opt into a trusted plain-http path (e.g. a host-local gateway or an encrypted overlay), or use https:// / a loopback host instead`,
      );
    }
    console.warn(
      `${field}.baseUrl is plain http (allowPlainHttp): the key and vault text are sent in clear to ${judgeBaseUrlHost(effectiveBaseUrl)}`,
    );
  }
  return {
    client: createTypesafeClient({
      baseUrl: config.baseUrl,
      apiKey: key,
      timeoutMs: config.timeoutMs,
      fetchFn,
    }),
    model: config.model,
    threshold: config.threshold,
  };
}
