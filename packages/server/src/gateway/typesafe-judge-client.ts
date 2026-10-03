// Builds the TypeSafe client for a judge block: one construction path for every consumer
// (experiential.citationInfer.judge and wikiJudge), so the model / threshold / key / baseUrl
// rules cannot drift between them. The config-load schema enforces the same rules through
// typesafeJudgeIssues (shared/net-host.ts); this enforces them again because the callers are
// duck-typed and reachable without ServerConfigSchema.parse. Nothing here falls back to another
// provider: a misconfigured block throws, and the caller decides what "no judge" means.
import {
  classifyJudgeBaseUrl,
  isPlainHttpHostListed,
  judgeBaseUrlHost,
} from "@the-40-thieves/obsidian-tc-shared";
import { resolveApiKey } from "../embeddings/provider";
import type { ResolveHost } from "./plain-http";
import { createTypesafeClient, type TypesafeClient } from "./typesafe";

export interface TypesafeJudgeClientConfig {
  model?: string | undefined;
  threshold?: number | undefined;
  apiKey?: string | undefined;
  apiKeyEnv?: string | undefined;
  baseUrl?: string | undefined;
  /** Exact hostnames a non-loopback http:// `baseUrl` may name; each must also resolve only to
   *  private addresses when a request is sent (gateway/plain-http.ts). */
  plainHttpHosts?: readonly string[] | undefined;
  /** DEPRECATED, removed at the next major release. Means "this baseUrl's own host is in
   *  plainHttpHosts": the connect-time private-address check still applies. */
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

export interface TypesafeJudgeClientDeps {
  /** DNS seam for the connect-time plain-http check (tests). */
  resolveHost?: ResolveHost | undefined;
}

export interface TypesafeJudgeClient {
  client: TypesafeClient;
  model: string;
  threshold: number;
}

/** The hosts a judge block's client may send plain http:// to: its `plainHttpHosts`, plus, for the
 *  deprecated `allowPlainHttp`, this `baseUrl`'s own host. One definition for the builder and the
 *  doctor probe, so neither can disagree about what the flag means. */
export function effectivePlainHttpHosts(config: {
  baseUrl?: string | undefined;
  plainHttpHosts?: readonly string[] | undefined;
  allowPlainHttp?: boolean | undefined;
}): string[] {
  const own = config.baseUrl === undefined ? undefined : judgeBaseUrlHost(config.baseUrl);
  return [
    ...(config.plainHttpHosts ?? []),
    ...(config.allowPlainHttp && own !== undefined ? [own] : []),
  ];
}

/** @throws when the model or threshold is missing, no key resolves, or baseUrl is not https (or
 *  loopback, or a plain-http host listed in plainHttpHosts). Warns, never throws, for a listed
 *  plain-http host and for the deprecated allowPlainHttp flag. The private-address check on a
 *  listed host happens at request time, in the client's transport. */
export function buildTypesafeJudgeClient(
  config: TypesafeJudgeClientConfig | undefined,
  names: TypesafeJudgeClientNames,
  fetchFn?: typeof fetch,
  deps: TypesafeJudgeClientDeps = {},
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
        "(plainHttpHosts only ever widens http:// on a non-loopback host, never any other scheme)",
    );
  }
  const ownHost = judgeBaseUrlHost(effectiveBaseUrl);
  const plainHttpHosts = effectivePlainHttpHosts({ ...config, baseUrl: effectiveBaseUrl });
  if (cls === "http-remote") {
    if (ownHost === undefined || !isPlainHttpHostListed(ownHost, plainHttpHosts)) {
      throw new Error(
        `${label}: provider is "typesafe" but ${field}.baseUrl is a ` +
          `non-loopback http:// URL whose host is not listed in ${field}.plainHttpHosts — this URL carries the ` +
          "bearer key and vault-derived text; list its exact hostname in " +
          `${field}.plainHttpHosts to opt into a trusted plain-http path (e.g. a host-local gateway or an encrypted overlay; it must resolve only to private addresses), or use https:// / a loopback host instead`,
      );
    }
    // One line: a flag that has no effect (https or loopback) is not worth a warning, and the
    // doctor and server_health report the deprecation whenever it is set.
    console.warn(
      config.allowPlainHttp
        ? `${field}.baseUrl is plain http (${field}.allowPlainHttp is deprecated and will be removed in the next major release: list ${JSON.stringify(ownHost)} in ${field}.plainHttpHosts instead; the private-address check still applies): the key and vault text are sent in clear to ${ownHost}`
        : `${field}.baseUrl is plain http (${field}.plainHttpHosts): the key and vault text are sent in clear to ${ownHost}`,
    );
  }
  return {
    client: createTypesafeClient({
      baseUrl: config.baseUrl,
      apiKey: key,
      timeoutMs: config.timeoutMs,
      fetchFn,
      plainHttpHosts,
      ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
    }),
    model: config.model,
    threshold: config.threshold,
  };
}
