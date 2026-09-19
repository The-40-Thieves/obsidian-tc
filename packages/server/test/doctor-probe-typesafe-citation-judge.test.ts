// THE-1078 — a direct unit test for `probeTypesafeCitationJudge` (cli/commands/doctor.ts): the
// one place in the doctor CLI that actually resolves an API key and hands it to a client, so it
// gets its own test rather than relying on the wiring/report-level test to notice a leak. Global
// `fetch` is stubbed (the function builds its own TypesafeClient internally, with no fetchFn
// seam) and restored after every test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeTypesafeCitationJudge } from "../src/cli/commands/doctor";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TYPESAFE_API_KEY;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probeTypesafeCitationJudge", () => {
  it("missing key -> early return with a reason naming apiKeyEnv, and NEVER calls fetch", async () => {
    delete process.env.TYPESAFE_API_KEY;
    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalled = true;
        return jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 1 } } });
      }),
    );
    const r = await probeTypesafeCitationJudge({ model: "jev-1.13.0" });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("TYPESAFE_API_KEY") });
    expect(fetchCalled).toBe(false);
  });

  it("a custom apiKeyEnv is named in the missing-key reason, not the default", async () => {
    delete process.env.MY_TS_KEY;
    vi.stubGlobal("fetch", vi.fn());
    const r = await probeTypesafeCitationJudge({ model: "jev-1.13.0", apiKeyEnv: "MY_TS_KEY" });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("MY_TS_KEY");
  });

  it("success maps ok:true and a numeric latencyMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.5 } } }),
      ),
    );
    const r = await probeTypesafeCitationJudge({ model: "jev-1.13.0", apiKey: "k" });
    expect(r.ok).toBe(true);
    expect(typeof (r as { latencyMs: number }).latencyMs).toBe("number");
    expect((r as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("an HTTP error maps ok:false with the status, and NEVER leaks the key into the result", async () => {
    const SENTINEL = "SENTINEL_KEY_DO_NOT_LEAK_9f3a";
    let sawAuthHeader = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: any) => {
        sawAuthHeader = init?.headers?.authorization ?? "";
        return jsonResponse({}, 401);
      }),
    );
    const r = await probeTypesafeCitationJudge({
      model: "jev-1.13.0",
      apiKey: SENTINEL,
      // maxAttempts isn't a probe param — the probe always uses the client's own default, so a
      // 401 (non-retryable) resolves on the first attempt regardless.
    });
    // Sanity: the key really was sent on the wire (proving this test would catch a real leak),
    // just never echoed back in the probe's own result.
    expect(sawAuthHeader).toBe(`Bearer ${SENTINEL}`);
    expect(r.ok).toBe(false);
    expect((r as { status?: number }).status).toBe(401);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("a network failure maps ok:false with a reason, and the result never contains the actual key", async () => {
    const SENTINEL = "SENTINEL_KEY_DO_NOT_LEAK_network";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // A realistic Node network error carries its code on `.code`; the client reports ONLY the
        // error's name and code, never its message (which a fetch wrapper could fill with headers).
        const e = new Error("connect ECONNREFUSED 1.2.3.4:443") as Error & { code?: string };
        e.code = "ECONNREFUSED";
        throw e;
      }),
    );
    const r = await probeTypesafeCitationJudge({ model: "jev-1.13.0", apiKey: SENTINEL });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("ECONNREFUSED");
    // The client never string-interpolates the key into any message it builds (gateway/
    // typesafe.ts); this confirms the actual key value used for this call never surfaces here.
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
});
