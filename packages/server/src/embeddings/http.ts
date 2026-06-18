import { err } from "@obsidian-tc/shared";
export type FetchFn = typeof fetch;
export interface PostJsonOptions {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  provider: string;
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
      throw err.operationTimeout("timed out", { provider: o.provider });
    throw err.embeddingProviderError("request failed", { provider: o.provider });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw err.embeddingProviderError(`HTTP ${res.status}`, { provider: o.provider });
  return (await res.json()) as T;
}
