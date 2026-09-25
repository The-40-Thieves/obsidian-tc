// THE-1133 (`@modelcontextprotocol/server` 2.0.0 -> 2.1.0, PR 1): proves the upstream request-id-0
// fix (PR #2654, "Treat request id `0` as a real id") against OUR server, not just upstream's own
// suite. Two guards in the SDK's shared `Protocol` base tested a `RequestId` for truthiness, so the
// legal JSON-RPC id `0` was read as absent:
//   - `notifications/cancelled` carrying `requestId: 0` was ignored, and the in-flight handler ran
//     to completion with its `AbortSignal` never fired.
//   - A notification sent with `relatedRequestId: 0` wrongly passed the debounce gate.
// Id `0` is not a corner case here: the outbound/inbound request counters are zero-based, so it is
// the id every peer assigns its FIRST request on a connection — for us, `initialize` itself. This
// suite drives a request through our real `tools/call` handler (mcp/server.ts) with id `0` by
// hand-crafting the raw JSON-RPC message over `InMemoryTransport` (real `Client`/`Server`, real
// wire messages — not registry.dispatch called directly), the same pattern
// mcp-client-compat-matrix.test.ts and facade-elicit-token.test.ts use to reach the wire handler
// rather than its shape from source. `initialize` itself consumes the client's own id `0`; id `0`
// is reused for a LATER `tools/call` here because JSON-RPC ids only need to be unique among
// requests the SENDER currently has in flight, not globally — the `initialize` response has
// already resolved and been removed from the pending-request map by the time this test reuses it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { openMemoryDb } from "./helpers";

/** A tool whose handler blocks until it either observes its `AbortSignal` fire or a safety timeout
 *  elapses — the direct probe for "did `notifications/cancelled` targeting THIS request's id `0`
 *  actually reach the handler's signal". Resolves `outcome` to `"aborted"` or `"timed-out"` rather
 *  than throwing, so a fix regression fails on an assertion (readable diff) instead of a bare
 *  unhandled-rejection timeout. */
function blockingTool(outcome: { value: "pending" | "aborted" | "timed-out" }): ToolDefinition {
  return {
    name: "block_until_signal",
    description: "test-only: resolves once ctx.signal aborts or a safety timeout fires",
    inputSchema: z.object({}),
    requiredScopes: [],
    handler: (_i: Record<string, never>, ctx: CallerContext) =>
      new Promise((resolve) => {
        if (ctx.signal?.aborted) {
          outcome.value = "aborted";
          resolve({ ok: true });
          return;
        }
        const safety = setTimeout(() => {
          outcome.value = "timed-out";
          resolve({ ok: true });
        }, 2000);
        ctx.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(safety);
            outcome.value = "aborted";
            resolve({ ok: true });
          },
          { once: true },
        );
      }),
  } as unknown as ToolDefinition;
}

async function bootStdioForIdZero(outcome: { value: "pending" | "aborted" | "timed-out" }) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry();
  registry.register(blockingTool(outcome));
  const context = (signal?: AbortSignal): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
    signal,
  });
  const server = createMcpServer({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "id-zero-test", version: "0.0.0" });
  await client.connect(clientTransport); // consumes the CLIENT's own id 0 for `initialize`
  return { server, client, clientTransport };
}

describe("THE-1133: request id `0` is a real id, not absent (SDK PR #2654)", () => {
  it("`notifications/cancelled` targeting a request with id 0 aborts that request's signal", async () => {
    const outcome: { value: "pending" | "aborted" | "timed-out" } = { value: "pending" };
    const { server, client, clientTransport } = await bootStdioForIdZero(outcome);
    try {
      // Hand-craft the raw wire message so id 0 is EXPLICIT, not whatever the Client's own
      // counter would assign next (initialize already consumed the client's id 0; letting the
      // SDK assign the id for this call would give it 1, missing the case entirely).
      clientTransport.send({
        jsonrpc: "2.0",
        id: 0,
        method: "tools/call",
        params: { name: "block_until_signal", arguments: {} },
      });
      // Give the handler's synchronous prelude (abort-listener registration, before its first
      // await) a turn to run before the cancellation arrives.
      await new Promise((r) => setTimeout(r, 10));
      clientTransport.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 0 },
      });

      // Poll rather than await a fixed sleep: pass the instant the handler settles, fail loudly
      // (via the outcome value, not a bare timeout) if it never does.
      const deadline = Date.now() + 3000;
      while (outcome.value === "pending" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(outcome.value).toBe("aborted"); // NOT "timed-out" — the 2.0.0 regression
    } finally {
      await client.close();
      await server.close();
    }
  });
});
