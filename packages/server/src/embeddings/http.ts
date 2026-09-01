import { err, extractCauseCode } from "@the-40-thieves/obsidian-tc-shared";
export type FetchFn = typeof fetch;
/** Which config block actually holds this endpoint's credential (THE-680).
 *
 *  REQUIRED on PostJsonOptions rather than defaulted: `postJson` is shared by the embedding
 *  adapters, both reranker adapters and the two model-tier service clients, and each reads its key
 *  from a different place. A default would let a new adapter inherit the `embeddings` hint silently
 *  — which is the bug this type exists to close — so the typechecker makes every call site say
 *  which block it means.
 *
 *  - `embeddings`     — embeddings.apiKey / embeddings.apiKeyEnv
 *  - `reranker`       — reranker.apiKey / reranker.apiKeyEnv
 *  - `modelTierFull`  — embeddings.modelTier.full.authToken
 *  - `none`           — the endpoint is sent no credential by this client at all (bare vLLM, TEI)
 */
export type CredentialSlot = "embeddings" | "reranker" | "modelTierFull" | "none";

interface PostJsonBase {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  provider: string;
}

/** THE-837: an adapter's own advice for a credential-less failure, carried instead of branched on.
 *
 *  This is a DISCRIMINATED UNION, not an optional field on a flat interface, and that is the whole
 *  point. `credentialLessHint` is reachable only on the `none` slot; the other three slots type it
 *  as `never`, so a caller cannot attach credential-less advice to a credentialed endpoint even by
 *  accident. The invariant the docblock below describes is therefore enforced by the typechecker
 *  rather than restated in prose — every one of the call sites is a direct object literal, so
 *  excess-property checking sees it.
 */
export type PostJsonOptions = PostJsonBase &
  (
    | { credentialSlot: Exclude<CredentialSlot, "none">; credentialLessHint?: never }
    | { credentialSlot: "none"; credentialLessHint?: string }
  );

/** Actionable hint attached to embedding-provider failures.
 *
 *  The SLOT is authoritative and is examined first. An earlier revision short-circuited on a
 *  specific provider's name before looking at the slot, which meant a caller passing that provider
 *  with `credentialSlot: "reranker"` got a hint naming `embeddings.model` — the exact
 *  wrong-config-block failure this function exists to prevent, reintroduced one branch above the
 *  fix. Provider-specific advice is nested INSIDE the slot it is valid for, so no reachable input
 *  can produce a key belonging to a slot the caller did not declare.
 *
 *  THE-837: this function no longer knows any vendor. It used to carry a
 *  `provider === "<vendor>"` branch in the `none` case, which made the shared transport — used by
 *  every embedding adapter, both reranker adapters and both model-tier clients — privilege one
 *  provider over the other seven registered in `providers/registry.ts`. An adapter that wants
 *  vendor-specific advice now supplies it at its own `postJson` call site, where the knowledge
 *  belongs. `scripts/check-embedding-transport-vendor-neutral.mjs` is the standing gate; it derives
 *  its provider set FROM the registry, so a provider added later is covered without touching it. */
function providerHint(o: PostJsonOptions): string {
  const reach = `check that the ${o.provider} endpoint (${o.url}) is reachable`;
  switch (o.credentialSlot) {
    case "embeddings":
      return `${reach} and a key is configured — set embeddings.apiKey, or name an environment variable with embeddings.apiKeyEnv.`;
    case "reranker":
      return `${reach} and a key is configured — set reranker.apiKey, or name an environment variable with reranker.apiKeyEnv.`;
    case "modelTierFull":
      return `${reach} and a token is configured — set embeddings.modelTier.full.authToken.`;
    case "none":
      // An adapter's own first-run advice wins when it supplied one ("is the service up, is the
      // model pulled"), because only the adapter knows what its endpoint needs. Otherwise: saying
      // "configure a key" here would send the operator to a knob that reaches nothing, since this
      // client sends no authorization header. A 401/403 therefore means something in FRONT of the
      // service is authenticating, which is a different fix entirely.
      return (
        o.credentialLessHint ??
        `${reach}. This client sends it no credential, so a 401/403 means a proxy or gateway in front of it is demanding one.`
      );
  }
}

export async function postJson<T>(o: PostJsonOptions): Promise<T> {
  const fetchFn = o.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 30_000);
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(o.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.headers ?? {}) },
      body: JSON.stringify(o.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError")
      throw err.operationTimeout("timed out", { provider: o.provider, url: o.url });
    // THE-923: the fetch cause (TLS trust, ECONNREFUSED, ENOTFOUND, ...), same shared unwrapper
    // as the bridge transport — this catch previously discarded it entirely.
    const causeCode = extractCauseCode(e);
    throw err.embeddingProviderError("request failed", {
      provider: o.provider,
      url: o.url,
      hint: providerHint(o),
      ...(causeCode ? { cause_code: causeCode } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok)
    // `status` is structured (not only in the message) so the indexer can tell a rejected
    // request (400/413: batch exceeds the provider context, THE-390) from an outage.
    throw err.embeddingProviderError(`HTTP ${res.status}`, {
      provider: o.provider,
      url: o.url,
      status: res.status,
      hint: providerHint(o),
    });
  try {
    return (await res.json()) as T;
  } catch {
    // A 2xx with a malformed / non-JSON body: surface the typed provider error (with
    // provider/url/hint) instead of leaking a raw SyntaxError to callers.
    throw err.embeddingProviderError("invalid JSON in response body", {
      provider: o.provider,
      url: o.url,
      hint: providerHint(o),
    });
  }
}
