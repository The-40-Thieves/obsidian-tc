import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { MetricsRecorder } from "../src/metrics/registry";

// Audit writes to event_log are swallowed on error, so a no-op db keeps these tests focused
// on the Prometheus recording path without a real SQLite fixture.
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

const tool = (name: string, requiredScopes: string[], handler: () => unknown) => ({
  name,
  description: "",
  inputSchema: z.object({}).strict(),
  requiredScopes,
  handler,
});

describe("dispatch -> Prometheus metrics (THE-211)", () => {
  it("records tool_calls_total(ok) + duration on success", async () => {
    const metrics = new MetricsRecorder();
    const reg = new ToolRegistry({ metrics });
    reg.register(tool("read_note", ["read:notes"], () => ({ ok: 1 })));
    await reg.dispatch("read_note", {}, ctx());
    const text = await metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_tool_calls_total{vault="main",tool="read_note",status="ok"} 1',
    );
    expect(text).toContain(
      'obsidian_tc_tool_duration_seconds_count{vault="main",tool="read_note"} 1',
    );
  });

  it("records denied + acl_denied(scope_class=write) on a missing-scope forbidden", async () => {
    const metrics = new MetricsRecorder();
    const reg = new ToolRegistry({ metrics });
    reg.register(tool("update_frontmatter", ["write:meta"], () => ({})));
    await reg.dispatch("update_frontmatter", {}, ctx({ grantedScopes: new Set(["read:notes"]) }));
    const text = await metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_tool_calls_total{vault="main",tool="update_frontmatter",status="denied"} 1',
    );
    expect(text).toContain(
      'obsidian_tc_acl_denied_total{vault="main",scope_class="write",reason="forbidden"} 1',
    );
  });

  it("records hitl_elicited + denied when an elicit token is required and absent", async () => {
    const metrics = new MetricsRecorder();
    const reg = new ToolRegistry({ metrics, verifyElicit: () => false });
    reg.register(tool("bulk_delete_notes", ["write:notes", "bulk:notes"], () => ({})));
    await reg.dispatch("bulk_delete_notes", {}, ctx({ elicitToken: null }));
    const text = await metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_hitl_elicited_total{vault="main",tool="bulk_delete_notes"} 1',
    );
    expect(text).toContain(
      'obsidian_tc_tool_calls_total{vault="main",tool="bulk_delete_notes",status="denied"} 1',
    );
  });

  it("records governor truncation + error status on overflow", async () => {
    const metrics = new MetricsRecorder();
    const reg = new ToolRegistry({ metrics, maxResponseBytes: 10 });
    reg.register(tool("big_read", [], () => ({ blob: "x".repeat(1000) })));
    await reg.dispatch("big_read", {}, ctx());
    const text = await metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_governor_truncations_total{vault="main",tool="big_read"} 1',
    );
    expect(text).toContain(
      'obsidian_tc_tool_calls_total{vault="main",tool="big_read",status="error"} 1',
    );
  });

  it("is a no-op (never throws) when no recorder is configured", async () => {
    const reg = new ToolRegistry();
    reg.register(tool("noop", [], () => ({})));
    const res = await reg.dispatch("noop", {}, ctx());
    expect(res.ok).toBe(true);
  });
});
