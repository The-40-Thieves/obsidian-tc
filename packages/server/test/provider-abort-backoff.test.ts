// A caller's abort (the wiki-judge deadline) cancelled the in-flight request but not the retry
// backoff: the client sat in a 60 s `Retry-After` sleep, leaving a pending promise and a live timer
// long after the tool had timed out. The reviewer's repro: `429 Retry-After: 60` with a deadline
// far below 60 s. The backoff must end the moment the caller aborts, with no timer left behind.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayClient } from "../src/gateway/client";
import { createTypesafeClient } from "../src/gateway/typesafe";
import { abortableSleep } from "../src/util/abortable-sleep";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const rateLimited = (headers: Record<string, string>): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ error: "slow down" }), {
      status: 429,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch;

describe("abortableSleep", () => {
  it("resolves after the delay, and immediately (timer cleared) on abort", async () => {
    let done = false;
    const ctrl = new AbortController();
    const p = abortableSleep(60_000, ctrl.signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    ctrl.abort();
    await p;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted signal does not start a timer at all", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await abortableSleep(60_000, ctrl.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without a signal it is a plain delay", async () => {
    let done = false;
    const p = abortableSleep(500).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });
});

describe("a caller abort cancels the retry backoff", () => {
  it("gateway client: 429 Retry-After: 60, deadline 50 ms", async () => {
    const ctrl = new AbortController();
    let fetches = 0;
    const base = rateLimited({ "retry-after": "60" });
    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:1",
      fetchFn: ((...a: Parameters<typeof fetch>) => {
        fetches++;
        return (base as (...x: Parameters<typeof fetch>) => Promise<Response>)(...a);
      }) as typeof fetch,
      timeoutMs: 120_000,
    });
    const p = client
      .judge({ messages: [{ role: "user", content: "x" }], sourcePaths: [], signal: ctrl.signal })
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(fetches).toBe(1);
    ctrl.abort();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(fetches).toBe(1); // no retry fired after the abort
    expect(vi.getTimerCount()).toBe(0); // and no backoff (or attempt) timer is left alive
  });

  it("typesafe client: 429 Retry-After: 60, deadline 50 ms", async () => {
    const ctrl = new AbortController();
    let fetches = 0;
    const base = rateLimited({ "retry-after": "60" });
    const client = createTypesafeClient({
      baseUrl: "https://api.typesafe.test",
      apiKey: "k",
      fetchFn: ((...a: Parameters<typeof fetch>) => {
        fetches++;
        return (base as (...x: Parameters<typeof fetch>) => Promise<Response>)(...a);
      }) as typeof fetch,
      timeoutMs: 120_000,
    });
    const p = client
      .noul({
        state: { a: 1 },
        model: "jev-1.13.0",
        instructions: "q?",
        criteria: { true: "yes", false: "no" },
        signal: ctrl.signal,
      })
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(fetches).toBe(1);
    ctrl.abort();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(fetches).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a sleepFn seam receives the caller's signal (so a custom one can honour it too)", async () => {
    const ctrl = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:1",
      fetchFn: rateLimited({ "retry-after": "1" }),
      maxAttempts: 2,
      sleepFn: async (_ms, signal) => {
        seen.push(signal);
      },
    });
    await client
      .judge({ messages: [{ role: "user", content: "x" }], sourcePaths: [], signal: ctrl.signal })
      .catch(() => undefined);
    expect(seen).toEqual([ctrl.signal]);
  });
});
