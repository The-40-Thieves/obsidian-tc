import { err } from "@the-40-thieves/obsidian-tc-shared";
export type FetchFn = typeof fetch;
export interface PostJsonOptions {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  provider: string;
}

/** Provider-aware, actionable hint attached to embedding-provider failures. */
function providerHint(provider: string, url: string): string {
  if (provider === "ollama")
    return `is Ollama running at ${url}? Start it, then pull the embedding model (e.g. \`ollama pull nomic-embed-text\`, or whatever embeddings.model is set to).`;
  return `check that the ${provider} endpoint (${url}) is reachable and embeddings.api_key is set (or the provider's API-key env var).`;
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
      hint: providerHint(o.provider, o.url),
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
      hint: providerHint(o.provider, o.url),
    });
  try {
    return (await res.json()) as T;
  } catch {
    // A 2xx with a malformed / non-JSON body: surface the typed provider error (with
    // provider/url/hint) instead of leaking a raw SyntaxError to callers.
    throw err.embeddingProviderError("invalid JSON in response body", {
      provider: o.provider,
      url: o.url,
      hint: providerHint(o.provider, o.url),
    });
  }
}
