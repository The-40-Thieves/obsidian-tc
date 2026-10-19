// The /oauth/* body guard. Before it, the OAuth handlers awaited an unauthenticated body with no
// deadline: a body that drips in (declared, under the size cap) held the connection until the
// runtime's idle timer fired. The guard reads the body under a byte cap and a deadline, answers
// 408 or 413 with `Connection: close`, and hands the handler a buffered copy of a body that arrived.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FORM_MAX_BYTES, oauthBodyGuard } from "../src/auth/oauth-body";
import { stallTimeout } from "./stall-timeouts";

const encoder = new TextEncoder();
const FORM = "content-type";
const FORM_TYPE = "application/x-www-form-urlencoded";

/** An app shaped like the real routes: the guard on /oauth/*, handlers that read the body. */
function app(deadlineMs = 200) {
  const a = new Hono();
  a.use("/oauth/*", oauthBodyGuard({ deadlineMs }));
  a.post("/oauth/token", async (c) => c.text(`form:${await c.req.text()}`));
  a.post("/oauth/passkey/login/verify", async (c) => c.json(await c.req.json()));
  return a;
}

/** A body that sends its first bytes and never closes, the drip a stalled client sends. */
function stalled(first: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
    },
  });
}

/** A body the test drives: `chunks` are sent and the stream closes; `onPull` counts reads. */
function drive(chunks: string[], onPull?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
      pull() {
        onPull?.();
      },
    },
    { highWaterMark: 0 },
  );
}

async function post(
  path: string,
  body: ReadableStream<Uint8Array> | string | undefined,
  headers: Record<string, string>,
  a = app(),
): Promise<Response> {
  return a.request(path, {
    method: "POST",
    headers,
    body,
    ...(typeof body === "object" ? { duplex: "half" } : {}),
  } as RequestInit);
}

describe("OAuth body deadline (/oauth/* guard)", () => {
  it(
    "a body that stalls answers 408 with Connection: close inside the deadline",
    async () => {
      const started = Date.now();
      const res = await post(
        "/oauth/token",
        stalled("grant_type="),
        { [FORM]: FORM_TYPE, "content-length": "100" },
        app(200),
      );
      expect(res.status).toBe(408);
      expect(res.headers.get("connection")).toBe("close");
      // The deadline is 200 ms; the answer must not wait on the body.
      expect(Date.now() - started).toBeLessThan(200 + 500);
    },
    stallTimeout(5_000),
  );

  it("a chunked body over the cap answers 413 with Connection: close", async () => {
    const chunk = "x".repeat(FORM_MAX_BYTES + 1);
    const res = await post("/oauth/token", drive([`a=${chunk}`]), {
      [FORM]: FORM_TYPE,
      "transfer-encoding": "chunked",
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
    expect(await res.text()).toBe("Payload Too Large");
  });

  it("a declared body over the cap answers 413 without reading it", async () => {
    let pulls = 0;
    const res = await post(
      "/oauth/token",
      drive(["a=1"], () => pulls++),
      { [FORM]: FORM_TYPE, "content-length": String(FORM_MAX_BYTES + 1) },
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
    expect(pulls).toBe(0);
  });

  it("a form body under the cap reaches the handler intact", async () => {
    const res = await post("/oauth/token", drive(["grant_type=authorization_code"]), {
      [FORM]: FORM_TYPE,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("form:grant_type=authorization_code");
  });

  it("a JSON body reaches a handler that calls c.req.json()", async () => {
    const res = await post(
      "/oauth/passkey/login/verify",
      drive([JSON.stringify({ id: "abc", n: 1 })]),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc", n: 1 });
  });

  it("a request with no body passes through untouched", async () => {
    const res = await post("/oauth/token", undefined, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("form:");
  });
});
