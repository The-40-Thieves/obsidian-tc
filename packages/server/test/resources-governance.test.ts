import { err } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { MetricsRecorder } from "../src/metrics/registry";
import type { RateLimiter } from "../src/throttle";

// THE-415: resources/list + resources/read used to bypass ToolRegistry.dispatch entirely, so they
// were never rate-limited and never audited. resources.ts still owns authorization; these assert
// the GOVERNANCE that dispatchResource adds.

const fakeDb = { prepare: () => ({ run: () => undefined }) } as unknown as Database;

function ctx(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db: fakeDb,
    ...overrides,
  };
}

describe("resources run under shared governance (THE-415)", () => {
  it("records a tool-call metric for resources/read, like any tool", async () => {
    const metrics = new MetricsRecorder();
    const reg = new ToolRegistry({ metrics });
    await reg.dispatchResource("resources/read", ctx(), ["read:notes"], { uri: "a.md" }, () => ({
      contents: [],
    }));
    const text = await metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_tool_calls_total{vault="main",tool="resources/read",status="ok"} 1',
    );
  });

  it("is governed by the SAME rate limiter as tools (the gap this closes)", async () => {
    const metrics = new MetricsRecorder();
    const limiter = {
      check: () => ({ ok: false, scopeClass: "read", retryAfterSeconds: 3, currentBurst: 9 }),
    } as unknown as RateLimiter;
    const reg = new ToolRegistry({ metrics, rateLimiter: limiter });
    let called = false;
    await expect(
      reg.dispatchResource("resources/read", ctx(), ["read:notes"], { uri: "a.md" }, () => {
        called = true;
        return { contents: [] };
      }),
    ).rejects.toMatchObject({ code: "throttled" });
    // Throttle must reject BEFORE the read runs, or the limiter buys nothing.
    expect(called).toBe(false);
    const text = await metrics.metrics();
    expect(text).toContain('obsidian_tc_rate_limit_hits_total{vault="main",scope_class="read"} 1');
  });

  it("records an error outcome when the resource handler throws", async () => {
    const metrics = new MetricsRecorder();
    const reg = new ToolRegistry({ metrics });
    await expect(
      reg.dispatchResource("resources/list", ctx(), ["read:notes"], {}, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const text = await metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_tool_calls_total{vault="main",tool="resources/list",status="error"} 1',
    );
  });

  // THE-514 item 1: dispatchResource's completion fan-out used to be a hand-copied REDUCED
  // version of emitCompletion's — it relayed only tc.tool.call.completed and never the
  // per-error-code signal, so an ACL-denied resource read never produced tc.acl.denied the way an
  // ACL-denied TOOL call does. Now both go through the same relayCompletion method (registry.ts),
  // so a resource read that fails with an ACL-shaped code gets the same fan-out a tool gets.
  it("relays tc.acl.denied for a resource read denied with an ACL-shaped code (parity with tools)", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const reg = new ToolRegistry({ emit: (_vaultId, type, data) => events.push({ type, data }) });
    await expect(
      reg.dispatchResource("resources/read", ctx(), ["read:notes"], { uri: "a.md" }, () => {
        throw err.aclDenied("path denied by folder ACL");
      }),
    ).rejects.toThrow();
    const types = events.map((e) => e.type);
    expect(types).toContain("tc.tool.call.completed");
    expect(types).toContain("tc.acl.denied");
  });
});
