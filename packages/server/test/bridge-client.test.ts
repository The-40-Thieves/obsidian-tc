import type { ObsidianTcError } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { type FakeRequestInfo, fakeBridgeTransport } from "../src/bridge/fake";
import { createBridgeClient } from "../src/bridge/transport";

const BASE = "http://127.0.0.1:27124";

async function caught(p: Promise<unknown>): Promise<ObsidianTcError> {
  try {
    await p;
  } catch (e) {
    return e as ObsidianTcError;
  }
  throw new Error("expected the request to reject");
}

describe("bridge client over an injectable transport", () => {
  it("unwraps a successful POST envelope and sends bearer + json headers to the prefixed route", async () => {
    let seen: FakeRequestInfo | undefined;
    const fetchFn = fakeBridgeTransport({
      routes: {
        "POST /obsidian-tc/v1/dataview/query": { body: { ok: true, result: { rows: [[1]] } } },
      },
      onRequest: (i) => {
        seen = i;
      },
    });
    const client = createBridgeClient({ baseUrl: BASE, apiKey: "k-secret", fetchFn });
    const out = await client.request<{ rows: number[][] }>({
      method: "POST",
      path: "/dataview/query",
      body: { dql: "TABLE file.name" },
      plugin: "dataview",
    });
    expect(out).toEqual({ rows: [[1]] });
    expect(seen?.url).toBe(`${BASE}/obsidian-tc/v1/dataview/query`);
    expect(seen?.method).toBe("POST");
    expect(seen?.headers.authorization).toBe("Bearer k-secret");
    expect(seen?.headers["content-type"]).toBe("application/json");
    expect(seen?.body).toBe(JSON.stringify({ dql: "TABLE file.name" }));
  });

  it("unwraps a GET envelope, trims a trailing slash on baseUrl, and sends no content-type", async () => {
    let seen: FakeRequestInfo | undefined;
    const fetchFn = fakeBridgeTransport({
      routes: {
        "GET /obsidian-tc/v1/probe": { body: { ok: true, result: { plugin_version: "0.1.0" } } },
      },
      onRequest: (i) => {
        seen = i;
      },
    });
    const client = createBridgeClient({ baseUrl: `${BASE}/`, apiKey: "k", fetchFn });
    const out = await client.request<{ plugin_version: string }>({ method: "GET", path: "/probe" });
    expect(out.plugin_version).toBe("0.1.0");
    expect(seen?.url).toBe(`${BASE}/obsidian-tc/v1/probe`);
    expect(seen?.headers["content-type"]).toBeUndefined();
  });

  it("omits the Authorization header when no apiKey is configured", async () => {
    let seen: FakeRequestInfo | undefined;
    const fetchFn = fakeBridgeTransport({
      routes: { "GET /obsidian-tc/v1/probe": { body: { ok: true, result: {} } } },
      onRequest: (i) => {
        seen = i;
      },
    });
    const client = createBridgeClient({ baseUrl: BASE, fetchFn });
    await client.request({ method: "GET", path: "/probe" });
    expect(seen?.headers.authorization).toBeUndefined();
  });

  it("maps a network failure to plugin_unreachable", async () => {
    const fetchFn = fakeBridgeTransport({
      routes: { "POST /obsidian-tc/v1/tasks/query": { networkError: true } },
    });
    const client = createBridgeClient({ baseUrl: BASE, fetchFn });
    const e = await caught(
      client.request({ method: "POST", path: "/tasks/query", body: {}, plugin: "tasks" }),
    );
    expect(e.code).toBe("plugin_unreachable");
    expect(e.details?.plugin).toBe("tasks");
  });

  it("maps an aborted request (timeout) to plugin_unreachable", async () => {
    const fetchFn = fakeBridgeTransport({
      routes: { "GET /obsidian-tc/v1/probe": { abort: true } },
    });
    const client = createBridgeClient({ baseUrl: BASE, fetchFn });
    expect((await caught(client.request({ method: "GET", path: "/probe" }))).code).toBe(
      "plugin_unreachable",
    );
  });

  it("maps a non-2xx response to plugin_unreachable", async () => {
    const fetchFn = fakeBridgeTransport({
      routes: { "POST /obsidian-tc/v1/ocr": { status: 503, body: {} } },
    });
    const client = createBridgeClient({ baseUrl: BASE, fetchFn });
    expect(
      (
        await caught(
          client.request({ method: "POST", path: "/ocr", body: {}, plugin: "text-extractor" }),
        )
      ).code,
    ).toBe("plugin_unreachable");
  });

  it("maps a 2xx with a malformed (non-envelope) body to plugin_unreachable", async () => {
    const fetchFn = fakeBridgeTransport({
      routes: { "GET /obsidian-tc/v1/probe": { status: 200, body: "not-an-envelope" } },
    });
    const client = createBridgeClient({ baseUrl: BASE, fetchFn });
    expect((await caught(client.request({ method: "GET", path: "/probe" }))).code).toBe(
      "plugin_unreachable",
    );
  });

  it("maps a bridge { ok:false, code:plugin_missing } envelope to plugin_missing", async () => {
    const fetchFn = fakeBridgeTransport({
      routes: {
        "POST /obsidian-tc/v1/dataview/query": {
          body: {
            ok: false,
            code: "plugin_missing",
            message: "dataview not installed",
            details: { plugin: "dataview" },
          },
        },
      },
    });
    const client = createBridgeClient({ baseUrl: BASE, fetchFn });
    const e = await caught(
      client.request({ method: "POST", path: "/dataview/query", body: {}, plugin: "dataview" }),
    );
    expect(e.code).toBe("plugin_missing");
    expect(e.details?.plugin).toBe("dataview");
  });

  it("passes through a known bridge error code (dql_error)", async () => {
    const fetchFn = fakeBridgeTransport({
      routes: {
        "POST /obsidian-tc/v1/dataview/query": {
          body: { ok: false, code: "dql_error", message: "parse error at line 1" },
        },
      },
    });
    const client = createBridgeClient({ baseUrl: BASE, fetchFn });
    expect(
      (await caught(client.request({ method: "POST", path: "/dataview/query", body: {} }))).code,
    ).toBe("dql_error");
  });

  it("collapses an unknown bridge error code to plugin_unreachable, recording bridge_code", async () => {
    const fetchFn = fakeBridgeTransport({
      routes: {
        "POST /obsidian-tc/v1/quickadd/trigger": {
          body: { ok: false, code: "weird_bridge_error", message: "boom" },
        },
      },
    });
    const client = createBridgeClient({ baseUrl: BASE, fetchFn });
    const e = await caught(
      client.request({ method: "POST", path: "/quickadd/trigger", body: {}, plugin: "quickadd" }),
    );
    expect(e.code).toBe("plugin_unreachable");
    expect(e.details?.bridge_code).toBe("weird_bridge_error");
  });

  it("never leaks the bearer token into an error payload", async () => {
    const fetchFn = fakeBridgeTransport({
      routes: { "POST /obsidian-tc/v1/tasks/query": { networkError: true } },
    });
    const client = createBridgeClient({ baseUrl: BASE, apiKey: "topsecret-token", fetchFn });
    const e = await caught(
      client.request({ method: "POST", path: "/tasks/query", body: {}, plugin: "tasks" }),
    );
    expect(JSON.stringify(e.toJSON())).not.toContain("topsecret-token");
  });
});
