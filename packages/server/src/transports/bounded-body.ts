/**
 * The outcome of {@linkcode readBoundedBody}. A failure carries the HTTP status the caller should
 * answer with: 413 when the body is over `maxBytes` (a declared Content-Length is refused without
 * reading anything), 408 when it did not finish within `deadlineMs`, and 400 when it cannot be read
 * at all (the body is already locked by someone else, or the stream errored).
 */
export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 400 | 408 | 413 };

export interface BoundedBodyOptions {
  /** Largest body, in bytes, that is read. A larger one is refused with 413. */
  maxBytes: number;
  /** Time allowed for the whole body to arrive. Past it the read is cancelled and the answer is 408. */
  deadlineMs: number;
}

/**
 * Read a request body under a byte cap and a deadline. Reads `req.body` itself (no `clone()`, which
 * would tee the stream and leave the original buffering a second copy), so the caller's request is
 * spent once the call returns. On any failure the reader is cancelled without being awaited: a
 * cancel that never settles must not hold the answer past the deadline.
 */
export async function readBoundedBody(
  req: Request,
  opts: BoundedBodyOptions,
): Promise<BoundedBodyResult> {
  const length = req.headers.get("content-length");
  if (length !== null && Number(length) > opts.maxBytes) return { ok: false, status: 413 };
  const stream: ReadableStream<Uint8Array> | null = req.body;
  if (stream === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = lockBody(stream);
  if (!reader) return { ok: false, status: 400 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.deadlineMs);
  });
  // Never rejects: a failed read is a 400, so no rejection outlives a deadline that won the race.
  const read = (async (): Promise<BoundedBodyResult> => {
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { ok: true, bytes: concat(chunks, total) };
        total += value.byteLength;
        if (total > opts.maxBytes) return { ok: false, status: 413 };
        chunks.push(value);
      }
    } catch {
      return { ok: false, status: 400 };
    }
  })();
  try {
    const outcome = await Promise.race([read, deadline]);
    if (outcome === "timeout") {
      void reader.cancel().catch(() => {});
      return { ok: false, status: 408 };
    }
    if (!outcome.ok) void reader.cancel().catch(() => {});
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The body's reader, or undefined when the body is already locked by someone else. */
function lockBody(body: ReadableStream<Uint8Array>) {
  try {
    return body.getReader();
  } catch {
    return undefined;
  }
}
