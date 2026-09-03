// THE-709 — the PLANE's per-attempt gateway timeout must be threaded, not just its attempt count.
//
// THE-700 gave the background plane its own retry budget (plane.gatewayMaxAttempts, default 6) on
// the theory that scheduled passes died on a Modal cold start. Attempts are the right lever for a
// TRANSIENT failure. They are the wrong one for a SLOW request: a call that cannot finish inside
// the per-attempt window fails identically on every attempt and merely multiplies the wasted
// wall-clock.
//
// Measured in production on 1.15.0 after THE-700 shipped: two synthesis jobs failed at 370.435s and
// 370.423s, 45 minutes apart — 6 x 60s plus backoff, agreeing to within 12ms. A cold start varies;
// a client-side budget expiring on schedule does not. Meanwhile the endpoint answered a small
// completion through the same gateway in 360ms, so there was nothing to wait out, and a
// synthesis-sized request (9,422 prompt tokens, 473 completion tokens) measured 28.9s — generation
// dominates, so a pass emitting a few thousand tokens crosses 60s comfortably.
//
// These tests pin the threading rather than the number. Without it, planeRoles falls back to the
// client's 60s default and the first test HANGS until vitest kills it — which is the failure this
// is meant to catch, so it is written to fail loudly rather than to assert a default.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planeRoles } from "../src/runtime/tool-wiring";

const ENV_URL = "OBSIDIAN_TC_GATEWAY_URL";
const ENV_TOKEN = "OBSIDIAN_TC_GATEWAY_TOKEN";

let savedUrl: string | undefined;
let savedToken: string | undefined;
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedUrl = process.env[ENV_URL];
  savedToken = process.env[ENV_TOKEN];
  savedFetch = globalThis.fetch;
  process.env[ENV_URL] = "http://gateway.invalid";
  process.env[ENV_TOKEN] = "test-token";
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env[ENV_URL];
  else process.env[ENV_URL] = savedUrl;
  if (savedToken === undefined) delete process.env[ENV_TOKEN];
  else process.env[ENV_TOKEN] = savedToken;
  globalThis.fetch = savedFetch;
  vi.restoreAllMocks();
});

/** A fetch that never settles on its own — it resolves ONLY when the caller's signal aborts. That
 *  makes the per-attempt timeout the sole thing that can end the call, so the elapsed time measures
 *  the budget rather than any server behaviour. */
function neverSettles(onAbort?: () => void): typeof globalThis.fetch {
  return ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal => genuinely hangs, which is itself the bug
      const fail = () => {
        onAbort?.();
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      };
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    })) as unknown as typeof globalThis.fetch;
}

describe("THE-709 — plane gateway per-attempt timeout", () => {
  it("threads timeoutMs into the plane's client, so a slow call is bounded by it and not by the 60s interactive default", async () => {
    globalThis.fetch = neverSettles();
    const roles = planeRoles(1, 40);
    expect(roles).not.toBeNull();

    const started = Date.now();
    await expect(
      roles?.synthesize({ messages: [{ role: "user", content: "hello" }], sourcePaths: [] }),
    ).rejects.toThrow();
    const elapsed = Date.now() - started;

    // Generous ceiling: the point is 40ms vs the 60_000ms default, so anything in this range proves
    // the knob reached the client. A regression that drops the threading blows past this by ~3
    // orders of magnitude and trips vitest's own timeout first.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("gives every attempt its own fresh window — N attempts wait ~N budgets, which is why attempts alone could not fix a slow call", async () => {
    let aborts = 0;
    globalThis.fetch = neverSettles(() => {
      aborts++;
    });
    const roles = planeRoles(3, 30);

    await expect(
      roles?.synthesize({ messages: [{ role: "user", content: "hello" }], sourcePaths: [] }),
    ).rejects.toThrow();

    // Each attempt must time out on its own controller. One abort would mean retries inherited a
    // fired signal; this is the property THE-615 established and THE-709 depends on — and it is
    // also why raising attempts multiplied the production failure from 180s to 370s instead of
    // fixing it.
    expect(aborts).toBe(3);
  });

  it("omits timeoutMs when unset, leaving the client's own default in charge", () => {
    // Absence must not become `timeoutMs: undefined` with a different meaning downstream. Only the
    // construction path is asserted here: a real 60s wait is not something to sit through in a test.
    globalThis.fetch = neverSettles();
    expect(planeRoles(1)).not.toBeNull();
  });

  it("returns null rather than throwing when the gateway is unconfigured", () => {
    delete process.env[ENV_URL];
    delete process.env[ENV_TOKEN];
    expect(planeRoles(6, 300_000)).toBeNull();
  });
});
