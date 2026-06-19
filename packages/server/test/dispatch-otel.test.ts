import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";

const fakeDb = { prepare: () => ({ run: () => undefined }) } as unknown as Database;

const ctx = (o: Partial<CallerContext> = {}): CallerContext => ({
  caller: "agent-x",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "main",
  db: fakeDb,
  ...o,
});

const tool = (name: string, requiredScopes: string[], handler: () => unknown) => ({
  name,
  description: "",
  inputSchema: z.object({}).strict(),
  requiredScopes,
  handler,
});

// A local (unregistered) provider keeps spans in memory — deterministic, no live collector.
function makeTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer("test"), exporter, provider };
}

describe("dispatch OTEL root span (G2.4)", () => {
  it("emits one obsidian_tc.<tool> SERVER span with the spec attributes on success", async () => {
    const { tracer, exporter, provider } = makeTracer();
    const reg = new ToolRegistry({ tracer });
    reg.register(tool("read_note", ["read:notes"], () => ({ ok: 1 })));
    await reg.dispatch("read_note", {}, ctx());
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const s = spans[0];
    expect(s?.name).toBe("obsidian_tc.read_note");
    expect(s?.kind).toBe(SpanKind.SERVER);
    expect(s?.attributes["obsidian_tc.tool"]).toBe("read_note");
    expect(s?.attributes["obsidian_tc.status"]).toBe("ok");
    expect(s?.attributes["obsidian_tc.scopes_required"]).toBe("read:notes");
    expect(typeof s?.attributes["obsidian_tc.caller_hash"]).toBe("string");
    expect(s?.status.code).toBe(SpanStatusCode.OK);
    await provider.shutdown();
  });

  it("marks the span ERROR with status=denied on a missing-scope forbidden", async () => {
    const { tracer, exporter, provider } = makeTracer();
    const reg = new ToolRegistry({ tracer });
    reg.register(tool("write_x", ["write:notes"], () => ({})));
    await reg.dispatch("write_x", {}, ctx({ grantedScopes: new Set(["read:notes"]) }));
    const s = exporter.getFinishedSpans()[0];
    expect(s?.attributes["obsidian_tc.status"]).toBe("denied");
    expect(s?.attributes["obsidian_tc.error_code"]).toBe("forbidden");
    expect(s?.status.code).toBe(SpanStatusCode.ERROR);
    await provider.shutdown();
  });

  it("creates no spans when no tracer is configured", async () => {
    const { exporter, provider } = makeTracer();
    const reg = new ToolRegistry(); // no tracer
    reg.register(tool("noop", [], () => ({})));
    await reg.dispatch("noop", {}, ctx());
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await provider.shutdown();
  });
});
