// M5 plur client + degradation gate (THE-181, Domain 24), exercised entirely
// against the deterministic fake bridge transport — no live plur. Proves the two
// degradation paths (unconfigured -> plugin_missing with NO network call;
// configured-but-down -> plugin_unreachable), the spec error mapping for a missing
// engram (invalid_input), and the security invariant that the bearer token reaches
// the transport header but never an error payload.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { type FakeRequestInfo, fakeBridgeTransport } from "../src/bridge";
import { createPlurClient, openPlur } from "../src/plur/client";

const ENDPOINT = "http://127.0.0.1:7077";
const TOKEN = "plur-secret";

describe("createPlurClient / openPlur gate", () => {
  it("returns undefined when no endpoint is configured", () => {
    expect(createPlurClient(undefined)).toBeUndefined();
    expect(createPlurClient({})).toBeUndefined();
    expect(createPlurClient({ apiKey: "k" })).toBeUndefined();
  });

  it("openPlur degrades to plugin_missing with NO network call when unconfigured", () => {
    let calls = 0;
    // A fake transport that would record any call; with no endpoint there is no
    // client, so the gate must throw before any transport is ever touched.
    fakeBridgeTransport({ onRequest: () => calls++ });
    const client = createPlurClient(undefined);
    expect(() => openPlur(client)).toThrow(ObsidianTcError);
    try {
      openPlur(client);
    } catch (e) {
      const error = e as ObsidianTcError;
      expect(error.code).toBe("plugin_missing");
      expect(error.details).toEqual({ plugin: "plur" });
    }
    expect(calls).toBe(0);
  });

  it("builds a client when an endpoint is configured", () => {
    const client = createPlurClient({ endpoint: ENDPOINT });
    expect(client).toBeDefined();
    expect(openPlur(client)).toBe(client);
  });
});

describe("plur request mapping via the fake transport", () => {
  function withRoutes(
    routes: Record<string, { status?: number; body?: unknown; networkError?: boolean }>,
  ) {
    const requests: FakeRequestInfo[] = [];
    const fetchFn = fakeBridgeTransport({ routes, onRequest: (i) => requests.push(i) });
    const client = createPlurClient({ endpoint: ENDPOINT, apiKey: TOKEN, fetchFn });
    if (!client) throw new Error("expected a plur client");
    return { client, requests };
  }

  it("returns the result envelope on a successful recall and sends the bearer header", async () => {
    const { client, requests } = withRoutes({
      "POST /recall": { body: { ok: true, result: { items: [{ engram_id: "e1", score: 0.9 }] } } },
    });
    const res = await client.request<{ items: unknown[] }>({
      method: "POST",
      path: "/recall",
      body: { query: "x", k: 10 },
      plugin: "plur",
    });
    expect(res.items).toEqual([{ engram_id: "e1", score: 0.9 }]);
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.url.endsWith("/recall")).toBe(true);
  });

  it("maps a transport failure to plugin_unreachable without leaking the token", async () => {
    const { client } = withRoutes({ "POST /recall": { networkError: true } });
    await expect(
      client.request({ method: "POST", path: "/recall", body: { query: "x" }, plugin: "plur" }),
    ).rejects.toMatchObject({ code: "plugin_unreachable", details: { plugin: "plur" } });
    // Drive it again to capture and stringify the surfaced error for a leak check.
    let surfaced = "";
    try {
      await client.request({
        method: "POST",
        path: "/recall",
        body: { query: "x" },
        plugin: "plur",
      });
    } catch (e) {
      surfaced = JSON.stringify((e as ObsidianTcError).toJSON());
    }
    expect(surfaced).not.toContain(TOKEN);
  });

  it("passes a plur invalid_input envelope (engram not found) through verbatim", async () => {
    const { client } = withRoutes({
      "POST /get": {
        status: 200,
        body: { ok: false, code: "invalid_input", message: "engram not found" },
      },
    });
    await expect(
      client.request({ method: "POST", path: "/get", body: { engram_id: "nope" }, plugin: "plur" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
