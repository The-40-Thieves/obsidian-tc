// Reading a provider response body under the caller's timeout and a hard size cap.
//
// Every provider client arms an AbortController for the request. Clearing it when the response
// HEADERS arrive left the body read unbounded: an endpoint that answers 200 and then stalls (or
// streams forever) held the request, its promise and its socket open indefinitely. Callers read the
// body through this helper INSIDE the same try/finally that owns the timer, so the abort that ends a
// slow request also ends a slow body, and the byte cap bounds one that never stops.

/** Far above any real provider answer (a large embeddings batch is a few MiB of JSON), far below a
 *  memory-exhaustion stream. */
export const MAX_PROVIDER_BODY_BYTES = 32 * 1024 * 1024;

export class ProviderBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`provider response exceeds ${limit} bytes`);
    this.name = "ProviderBodyTooLargeError";
  }
}

/** The response body as text, or a rejection when the body is larger than `maxBytes`. A rejection
 *  from the underlying stream (the request's abort signal firing, a reset connection) propagates
 *  unchanged for the caller to classify. The stream is cancelled on every failure path. */
export async function readBodyText(
  res: Response,
  maxBytes: number = MAX_PROVIDER_BODY_BYTES,
): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new ProviderBodyTooLargeError(maxBytes);
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ProviderBodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (e) {
    void reader.cancel().catch(() => undefined);
    throw e;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
