// THE-1125 — TelemetryCollector: the in-process counter set fed from MetricsRecorder's ONE
// observeToolCall hook (see registry.ts's ToolCallObserver comment).
import { describe, expect, it } from "vitest";
import { TelemetryCollector } from "../src/telemetry/collector";

describe("TelemetryCollector", () => {
  it("counts tool calls per name", () => {
    const c = new TelemetryCollector(() => 0);
    c.recordToolCall("search_text");
    c.recordToolCall("search_text");
    c.recordToolCall("read_note");
    expect(c.snapshot().toolCalls).toEqual({ search_text: 2, read_note: 1 });
  });

  it("counts error codes only when one is given (ok calls never touch errorCodes)", () => {
    const c = new TelemetryCollector(() => 0);
    c.recordToolCall("search_text");
    c.recordToolCall("search_text", "acl_denied");
    c.recordToolCall("write_note", "acl_denied");
    expect(c.snapshot().errorCodes).toEqual({ acl_denied: 2 });
  });

  it("caps distinct client names at 32 — a client past the cap is simply not added", () => {
    const c = new TelemetryCollector(() => 0);
    for (let i = 0; i < 50; i++) c.recordClientName(`client-${i}`);
    const names = c.snapshot().clientNames;
    expect(names.length).toBe(32);
  });

  it("a client name seen again after the cap does not evict or duplicate", () => {
    const c = new TelemetryCollector(() => 0);
    for (let i = 0; i < 32; i++) c.recordClientName(`client-${i}`);
    c.recordClientName("client-0"); // already present, under the cap: no-op either way
    c.recordClientName("client-99"); // new, at the cap: dropped
    const names = c.snapshot().clientNames;
    expect(names.length).toBe(32);
    expect(names).toContain("client-0");
    expect(names).not.toContain("client-99");
  });

  it("recordClientName(undefined) is a no-op (the ok/no-clientInfo case)", () => {
    const c = new TelemetryCollector(() => 0);
    c.recordClientName(undefined);
    expect(c.snapshot().clientNames).toEqual([]);
  });

  it("snapshot does not clear counters — a preview can be read repeatedly", () => {
    const c = new TelemetryCollector(() => 0);
    c.recordToolCall("search_text");
    c.snapshot();
    expect(c.snapshot().toolCalls).toEqual({ search_text: 1 });
  });

  it("reset clears every counter and opens a new window", () => {
    const c = new TelemetryCollector(() => 1000);
    c.recordToolCall("search_text", "throttled");
    c.recordClientName("claude-code");
    c.reset(() => 2000);
    const snap = c.snapshot(() => 3000);
    expect(snap.toolCalls).toEqual({});
    expect(snap.errorCodes).toEqual({});
    expect(snap.clientNames).toEqual([]);
    expect(snap.windowStart).toBe(2000);
    expect(snap.windowEnd).toBe(3000);
  });

  it("windowStart is set at construction and tracked across a window", () => {
    const c = new TelemetryCollector(() => 500);
    expect(c.snapshot(() => 900).windowStart).toBe(500);
    expect(c.snapshot(() => 900).windowEnd).toBe(900);
  });
});
