// THE-583: Logging, Roots and Sampling — the three server->client features SEP-2577 deprecated
// (>=12-month window) but did not remove, and which the SDK still implements at runtime.
//
// The load-bearing property under test is CAPABILITY GATING. Each of these is a request the server
// makes of the client, so calling one against a client that never advertised it is a protocol
// error rather than a soft miss. A helper that "works" in a test with a fully-capable client tells
// you nothing about the case that actually occurs — a client that advertised nothing.
import { Server } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  clientRoots,
  clientSupportsSampling,
  emitLog,
  LOG_LEVELS,
  type LogLevel,
  meetsLevel,
  sampleViaClient,
} from "../src/mcp/client-features";

/** A server whose client capabilities are forced, so gating can be tested without a real client. */
function serverWithCaps(caps: unknown): Server {
  const s = new Server({ name: "t", version: "0" }, { capabilities: { logging: {} } });
  (s as unknown as { getClientCapabilities: () => unknown }).getClientCapabilities = () => caps;
  return s;
}

describe("meetsLevel — RFC 5424 ordering", () => {
  it("orders the eight spec levels least to most severe", () => {
    expect(LOG_LEVELS).toEqual([
      "debug",
      "info",
      "notice",
      "warning",
      "error",
      "critical",
      "alert",
      "emergency",
    ]);
  });

  it("passes a message at or above the requested minimum and drops the rest", () => {
    expect(meetsLevel("error", "info")).toBe(true);
    expect(meetsLevel("info", "info")).toBe(true);
    expect(meetsLevel("debug", "info")).toBe(false);
    // The extremes, because an off-by-one in the index comparison would only show here.
    expect(meetsLevel("emergency", "debug")).toBe(true);
    expect(meetsLevel("debug", "emergency")).toBe(false);
  });
});

describe("emitLog — delegates to the PER-REQUEST sink", () => {
  // The contract changed with SEP-2575 and the reason is a MUST NOT. Verbosity is now a per-request
  // `_meta` field, and a server MUST NOT emit `notifications/message` for a request that did not
  // carry one. That gate lives in the SDK's `mcpReq.log` (it reads the request envelope and returns
  // silently when the field is absent) — NOT in `server.sendLoggingMessage`, which filters against a
  // session-keyed level a stateless server never populates and therefore emits to clients that never
  // asked. emitLog's whole job is now to hand the message to the right sink and stay out of the way,
  // so what is testable here is the forwarding, not the filtering.
  it("forwards level, data and logger to the sink", async () => {
    const calls: Array<[string, unknown, string | undefined]> = [];
    const sink = async (level: LogLevel, data: unknown, logger?: string) => {
      calls.push([level, data, logger]);
    };
    await emitLog(sink, { level: "warning", logger: "test", data: { k: 1 } });
    expect(calls).toEqual([["warning", { k: 1 }, "test"]]);
  });

  it("does NOT filter by level itself — the client's threshold is the SDK's to apply", async () => {
    // A server-side floor here would re-filter what the SDK already filtered, against the wrong
    // number: ours, not the one the client put on this request.
    const calls: string[] = [];
    const sink = async (level: LogLevel) => {
      calls.push(level);
    };
    await emitLog(sink, { level: "debug", logger: "test", data: {} });
    expect(calls).toEqual(["debug"]);
  });

  it("no-ops when there is no sink (stdio, direct construction, tests)", async () => {
    await expect(
      emitLog(undefined, { level: "emergency", logger: "test", data: {} }),
    ).resolves.toBeUndefined();
  });

  it("never throws when the sink throws — diagnostics must not fail the call", async () => {
    // The common real case: the client hung up mid-call.
    const sink = async () => {
      throw new Error("transport gone");
    };
    await expect(
      emitLog(sink, { level: "error", logger: "test", data: {} }),
    ).resolves.toBeUndefined();
  });
});

describe("roots — gated on the client advertising it", () => {
  it("returns undefined when the client advertised NO capabilities", async () => {
    // The overwhelmingly common case, and not an error.
    await expect(clientRoots(serverWithCaps({}))).resolves.toBeUndefined();
  });

  it("returns undefined when capabilities are absent entirely", async () => {
    await expect(clientRoots(serverWithCaps(undefined))).resolves.toBeUndefined();
  });

  it("asks the client when it DID advertise roots", async () => {
    const s = serverWithCaps({ roots: {} });
    (s as unknown as { listRoots: () => Promise<unknown> }).listRoots = async () => ({
      roots: [{ uri: "file:///vault", name: "vault" }],
    });
    await expect(clientRoots(s)).resolves.toEqual([{ uri: "file:///vault", name: "vault" }]);
  });

  it("returns undefined rather than throwing when the client errors", async () => {
    const s = serverWithCaps({ roots: {} });
    (s as unknown as { listRoots: () => Promise<unknown> }).listRoots = async () => {
      throw new Error("client refused");
    };
    await expect(clientRoots(s)).resolves.toBeUndefined();
  });
});

describe("sampling — gated, and never a silent substitute for the gateway", () => {
  it("reports unsupported when the client did not advertise sampling", () => {
    expect(clientSupportsSampling(serverWithCaps({}))).toBe(false);
    expect(clientSupportsSampling(serverWithCaps({ roots: {} }))).toBe(false);
  });

  it("reports supported when it did", () => {
    expect(clientSupportsSampling(serverWithCaps({ sampling: {} }))).toBe(true);
  });

  it("returns undefined instead of calling anything when unsupported", async () => {
    const s = serverWithCaps({});
    let called = false;
    (s as unknown as { createMessage: () => Promise<unknown> }).createMessage = async () => {
      called = true;
      return {};
    };
    await expect(sampleViaClient(s, { messages: [], maxTokens: 1 })).resolves.toBeUndefined();
    // The point: gating happens BEFORE the call, so an unsupported client is never asked.
    expect(called).toBe(false);
  });

  it("delegates to the client when supported", async () => {
    const s = serverWithCaps({ sampling: {} });
    (s as unknown as { createMessage: (p: unknown) => Promise<unknown> }).createMessage = async (
      p,
    ) => ({ echoed: p });
    await expect(
      sampleViaClient(s, { messages: [{ role: "user" }], maxTokens: 8 }),
    ).resolves.toMatchObject({ echoed: { maxTokens: 8 } });
  });
});
