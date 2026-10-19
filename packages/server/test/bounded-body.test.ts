// readBoundedBody reads a request body under a byte cap and a deadline, and never leaves the caller
// with a hung read or an unhandled rejection. The /mcp guard depends on it; these cases pin the
// shapes it returns and the cancel behaviour the socket relies on.
import { describe, expect, it } from "vitest";
import { readBoundedBody } from "../src/transports/bounded-body";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A body the test drives: `chunks` are enqueued up front; `open` keeps the stream from closing. */
function bodyStream(
  chunks: string[],
  hooks: { open?: boolean; onCancel?: () => Promise<void> | void; onPull?: () => void } = {},
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!hooks.open) controller.close();
      },
      pull() {
        hooks.onPull?.();
      },
      cancel() {
        return hooks.onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );
}

function post(body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("readBoundedBody", () => {
  it("returns the bytes of a body under the cap", async () => {
    const result = await readBoundedBody(post(bodyStream(['{"a":', "1}"])), {
      maxBytes: 1024,
      deadlineMs: 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(decoder.decode(result.bytes)).toBe('{"a":1}');
  });

  it("refuses a declared Content-Length over the cap with 413 without pulling the body", async () => {
    let pulled = false;
    const result = await readBoundedBody(
      post(bodyStream(["x"], { onPull: () => (pulled = true) }), { "content-length": "5000" }),
      { maxBytes: 1024, deadlineMs: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 413 });
    expect(pulled).toBe(false);
  });

  it("answers 413 for a chunked body that crosses the cap, and cancels the stream", async () => {
    let cancelled = false;
    const result = await readBoundedBody(
      post(
        bodyStream(["x".repeat(600), "x".repeat(600)], {
          open: true,
          onCancel: () => {
            cancelled = true;
          },
        }),
      ),
      { maxBytes: 1000, deadlineMs: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 413 });
    await tick();
    expect(cancelled).toBe(true);
  });

  it("answers 408 for a stalled body within the deadline, and cancels the stream", async () => {
    let cancelled = false;
    const started = performance.now();
    const result = await readBoundedBody(
      post(
        bodyStream(["{"], {
          open: true,
          onCancel: () => {
            cancelled = true;
          },
        }),
      ),
      { maxBytes: 1024, deadlineMs: 50 },
    );
    expect(result).toEqual({ ok: false, status: 408 });
    expect(performance.now() - started).toBeLessThan(50 + 100);
    await tick();
    expect(cancelled).toBe(true);
  });

  it("returns empty bytes for a null body", async () => {
    const result = await readBoundedBody(post(null), { maxBytes: 1024, deadlineMs: 1000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.byteLength).toBe(0);
  });

  it("still answers 408 on time when cancel() never settles", async () => {
    const started = performance.now();
    const result = await readBoundedBody(
      post(bodyStream(["{"], { open: true, onCancel: () => new Promise<void>(() => {}) })),
      { maxBytes: 1024, deadlineMs: 50 },
    );
    expect(result).toEqual({ ok: false, status: 408 });
    expect(performance.now() - started).toBeLessThan(50 + 100);
  });

  it("answers 400 for a body that is already locked, instead of throwing", async () => {
    const req = post(bodyStream(["{}"]));
    req.body?.getReader();
    const result = await readBoundedBody(req, { maxBytes: 1024, deadlineMs: 1000 });
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it("answers 400 for a body whose read errors, with no unhandled rejection", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("client went away"));
      },
    });
    const result = await readBoundedBody(post(body), { maxBytes: 1024, deadlineMs: 1000 });
    expect(result).toEqual({ ok: false, status: 400 });
  });
});
