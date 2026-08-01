import { err } from "@the-40-thieves/obsidian-tc-shared";
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

export interface PostJsonOptions {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  provider: string;
  credentialSlot: CredentialSlot;
}

/** Provider-aware, actionable hint attached to embedding-provider failures.
 *
 *  The SLOT is authoritative and is examined first. An earlier revision short-circuited on
 *  `provider === "ollama"` before looking at the slot, which meant a caller passing
 *  `{provider: "ollama", credentialSlot: "reranker"}` got a hint naming `embeddings.model` — the
 *  exact wrong-config-block failure this function exists to prevent, reintroduced one branch above
 *  the fix. Provider-specific advice is now nested INSIDE the slot it is valid for, so no reachable
 *  input can produce a key belonging to a slot the caller did not declare. */
function providerHint(provider: string, url: string, slot: CredentialSlot): string {
  const reach = `check that the ${provider} endpoint (${url}) is reachable`;
  switch (slot) {
    case "embeddings":
      return `${reach} and a key is configured — set embeddings.apiKey, or name an environment variable with embeddings.apiKeyEnv.`;
    case "reranker":
      return `${reach} and a key is configured — set reranker.apiKey, or name an environment variable with reranker.apiKeyEnv.`;
    case "modelTierFull":
      return `${reach} and a token is configured — set embeddings.modelTier.full.authToken.`;
    case "none":
      // Ollama is credential-less, so its advice belongs here and nowhere else: "is it running,
      // and is the model pulled" is the actual first-run failure, not a missing key.
      if (provider === "ollama")
        return `is Ollama running at ${url}? Start it, then pull the embedding model (e.g. \`ollama pull nomic-embed-text\`, or whatever embeddings.model is set to).`;
      // Saying "configure a key" here would send the operator to a knob that reaches nothing: this
      // client sends no authorization header. A 401/403 therefore means something in FRONT of the
      // service is authenticating, which is a different fix entirely.
      return `${reach}. This client sends it no credential, so a 401/403 means a proxy or gateway in front of it is demanding one.`;
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
    throw err.embeddingProviderError("request failed", {
      provider: o.provider,
      url: o.url,
      hint: providerHint(o.provider, o.url, o.credentialSlot),
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
      hint: providerHint(o.provider, o.url, o.credentialSlot),
    });
  try {
    return (await res.json()) as T;
  } catch {
    // A 2xx with a malformed / non-JSON body: surface the typed provider error (with
    // provider/url/hint) instead of leaking a raw SyntaxError to callers.
    throw err.embeddingProviderError("invalid JSON in response body", {
      provider: o.provider,
      url: o.url,
      hint: providerHint(o.provider, o.url, o.credentialSlot),
    });
  }
}
