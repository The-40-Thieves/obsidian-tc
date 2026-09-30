// observability.otel.detail: the child-span hierarchy under the per-request root span.
//
// Every test runs against a REGISTERED NodeTracerProvider (the exact call initOtel makes), because
// verbose mode parents handler-side spans through the OTel context manager and that only exists
// once a provider is registered. Spans are read back from an in-memory exporter, never a collector.
import { context, propagation, type Tracer, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { inSavepoint, inTransaction } from "../src/db/txn";
import { paginateByBytes, pagingOf } from "../src/mcp/byte-page";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { MAX_SPANS_PER_REQUEST, type OtelDetail, traceItem } from "../src/otel/dispatch-spans";

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const NOTE_BODY = "the-private-note-body-marker-7731";
const DENIED_PATH = "Private/denied-folder/secret-plans.md";

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;
let tracer: Tracer;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  tracer = provider.getTracer("test");
});
afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

// txn.ts only ever calls db.exec, so a no-op exec is a faithful stand-in for BEGIN/COMMIT.
const execDb = () => ({ exec: () => undefined }) as unknown as CallerContext["db"];
const fakeDb = { prepare: () => ({ run: () => undefined }) } as unknown as CallerContext["db"];
const ctx = (o: Partial<CallerContext> = {}): CallerContext => ({
  caller: "agent-x",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "main",
  db: fakeDb,
  ...o,
});

const tool = (name: string, handler: (input: any) => unknown, scopes = ["read:notes"]) => ({
  name,
  description: "",
  inputSchema: z.object({ q: z.string().optional() }).strict(),
  requiredScopes: scopes,
  handler,
});

const registry = (detail: OtelDetail | undefined, extra: Record<string, unknown> = {}) =>
  new ToolRegistry({ tracer, ...(detail ? { otelDetail: detail } : {}), ...extra });

const byName = (name: string) => exporter.getFinishedSpans().filter((s) => s.name === name);
const root = (): ReadableSpan => {
  const r = exporter.getFinishedSpans().filter((s) => s.parentSpanContext === undefined);
  expect(r).toHaveLength(1);
  return r[0] as ReadableSpan;
};
const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;
const names = () => exporter.getFinishedSpans().map((s) => s.name);

const STAGES = [
  "input_parse",
  "auth_check",
  "policy_eval",
  "acl_eval",
  "tool_impl",
  "output_serialize",
];

describe("detail = root (the default): current behaviour exactly", () => {
  it.each([undefined, "root" as const])(
    "emits one root span and nothing else (detail=%s)",
    async (d) => {
      const reg = registry(d);
      reg.register(tool("read_note", () => ({ ok: 1 })));
      await reg.dispatch("read_note", { q: "x" }, ctx());
      expect(names()).toEqual(["obsidian_tc.read_note"]);
      const s = root();
      // The exact attribute key set of the pre-existing root span: a new attribute here is a
      // behaviour change for every default-off-child operator.
      expect(Object.keys(s.attributes).sort()).toEqual(
        [
          "obsidian_tc.caller_hash",
          "obsidian_tc.duration_ms",
          "obsidian_tc.elicit_used",
          "obsidian_tc.scopes_required",
          "obsidian_tc.status",
          "obsidian_tc.tool",
          "obsidian_tc.vault_id",
          "rate_limit.hit",
        ].sort(),
      );
    },
  );

  it("root detail leaves handler-side helpers inert even when a handler uses them", async () => {
    const reg = registry("root");
    reg.register(
      tool("t", async () => {
        await traceItem("item", async () => 1);
        return inTransaction(execDb(), () => 1);
      }),
    );
    await reg.dispatch("t", {}, ctx());
    expect(names()).toEqual(["obsidian_tc.t"]);
  });
});

describe("detail = children", () => {
  it("emits the named stage spans, each parented to the root, in pipeline order", async () => {
    const reg = registry("children");
    reg.register(tool("read_note", () => ({ ok: 1 })));
    await reg.dispatch("read_note", {}, ctx());
    // Finish order == pipeline order for sequential siblings; the root ends last.
    expect(names()).toEqual([...STAGES, "obsidian_tc.read_note"]);
    const r = root();
    for (const stage of STAGES) {
      const [s] = byName(stage);
      expect(s?.parentSpanContext?.spanId).toBe(r.spanContext().spanId);
      expect(s?.spanContext().traceId).toBe(r.spanContext().traceId);
    }
    // required names from the brief
    for (const n of ["auth_check", "acl_eval", "policy_eval", "tool_impl", "output_serialize"])
      expect(names()).toContain(n);
  });

  it("adds idempotency / rate_limit / hitl_check stages only when those gates run", async () => {
    const reg = registry("children", {
      rateLimiter: { check: async () => ({ ok: true }) },
    });
    reg.register(tool("read_note", () => ({ ok: 1 })));
    await reg.dispatch("read_note", {}, ctx());
    expect(names()).toContain("rate_limit");
    expect(names().indexOf("rate_limit")).toBeGreaterThan(names().indexOf("policy_eval"));
    expect(names().indexOf("rate_limit")).toBeLessThan(names().indexOf("acl_eval"));
  });

  it("does NOT emit verbose-only spans (batch items, db transactions)", async () => {
    const reg = registry("children");
    reg.register(
      tool("t", async () => {
        await traceItem("item", async () => 1);
        return inTransaction(execDb(), () => 1);
      }),
    );
    await reg.dispatch("t", {}, ctx());
    expect(names()).toEqual([...STAGES, "obsidian_tc.t"]);
  });

  it("child spans carry no attributes on the success path", async () => {
    const reg = registry("children");
    reg.register(tool("read_note", () => ({ ok: 1 })));
    await reg.dispatch("read_note", {}, ctx());
    for (const stage of STAGES) expect(byName(stage)[0]?.attributes).toEqual({});
  });

  it("stays parented when the caller supplied a trace carrier", async () => {
    const reg = registry("children");
    reg.register(tool("read_note", () => ({ ok: 1 })));
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    await reg.dispatch("read_note", {}, ctx({ traceCarrier: { traceparent } }));
    const r = exporter.getFinishedSpans().find((s) => s.name === "obsidian_tc.read_note");
    expect(r?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    for (const stage of STAGES)
      expect(byName(stage)[0]?.parentSpanContext?.spanId).toBe(r?.spanContext().spanId);
  });
});

describe("detail = verbose", () => {
  it("parents db transaction spans under tool_impl", async () => {
    const db = execDb();
    const reg = registry("verbose");
    reg.register(
      tool("w", async () => {
        await Promise.resolve();
        inTransaction(db, () => 1);
        return inSavepoint(db, () => 2);
      }),
    );
    await reg.dispatch("w", {}, ctx());
    const impl = byName("tool_impl")[0] as ReadableSpan;
    expect(byName("db_transaction")).toHaveLength(1);
    expect(byName("db_savepoint")).toHaveLength(1);
    for (const t of [...byName("db_transaction"), ...byName("db_savepoint")])
      expect(parentOf(t)).toBe(impl.spanContext().spanId);
    expect(parentOf(impl)).toBe(root().spanContext().spanId);
  });

  it("emits one item span per batch item through paginateByBytes, ordered, under tool_impl", async () => {
    const reg = registry("verbose");
    reg.register(
      tool("read_notes", async (input) => {
        const items = ["a", "b", "c"];
        const page = await paginateByBytes<string, { v: string }>({
          paging: pagingOf(undefined),
          binding: { tool: "read_notes", principal: "agent-x", args: input },
          cursor: undefined,
          items,
          produce: (item) => ({ v: item }),
          tooLarge: (item) => ({ v: item }),
          frame: (entries, nextCursor) => ({ entries, next_cursor: nextCursor }),
        });
        return page;
      }),
    );
    await reg.dispatch("read_notes", {}, ctx());
    const impl = byName("tool_impl")[0] as ReadableSpan;
    const items = byName("batch_item");
    expect(items.map((s) => s.attributes["obsidian_tc.item_index"])).toEqual([0, 1, 2]);
    for (const s of items) expect(parentOf(s)).toBe(impl.spanContext().spanId);
  });

  it("caps spans per request and records how many were dropped on the root", async () => {
    const reg = registry("verbose");
    reg.register(
      tool("t", async () => {
        for (let i = 0; i < MAX_SPANS_PER_REQUEST * 3; i++)
          await traceItem("batch_item", async () => i);
        return { ok: 1 };
      }),
    );
    await reg.dispatch("t", {}, ctx());
    const all = exporter.getFinishedSpans();
    const children = all.filter((s) => s.parentSpanContext !== undefined);
    // Hard bound on the count of NON-root spans, whatever the handler does...
    expect(children.length).toBeLessThanOrEqual(MAX_SPANS_PER_REQUEST);
    // ...that cannot starve the pipeline stages of their own span.
    for (const stage of STAGES) expect(names()).toContain(stage);
    expect(byName("batch_item").length).toBeGreaterThan(0);
    const dropped = root().attributes["obsidian_tc.spans_dropped"];
    expect(dropped).toBe(MAX_SPANS_PER_REQUEST * 3 - byName("batch_item").length);
  });

  it("the cap is per request, not per process", async () => {
    const reg = registry("verbose");
    reg.register(
      tool("t", async () => {
        for (let i = 0; i < MAX_SPANS_PER_REQUEST * 2; i++)
          await traceItem("batch_item", async () => i);
        return { ok: 1 };
      }),
    );
    await reg.dispatch("t", {}, ctx());
    const first = byName("batch_item").length;
    exporter.reset();
    await reg.dispatch("t", {}, ctx());
    expect(byName("batch_item").length).toBe(first);
  });
});

describe("error path: the right span, status and structured code", () => {
  const errored = (s: ReadableSpan | undefined) => s?.status.code === 2;

  it("a missing scope marks auth_check (and only auth_check) with code forbidden", async () => {
    const reg = registry("children");
    reg.register(tool("write_x", () => ({}), ["write:notes"]));
    await reg.dispatch("write_x", {}, ctx({ grantedScopes: new Set(["read:notes"]) }));
    expect(names()).toEqual(["input_parse", "auth_check", "obsidian_tc.write_x"]);
    const a = byName("auth_check")[0];
    expect(errored(a)).toBe(true);
    expect(a?.status.message).toBe("forbidden");
    expect(a?.attributes["obsidian_tc.error_code"]).toBe("forbidden");
    expect(errored(byName("input_parse")[0])).toBe(false);
    expect(root().attributes["obsidian_tc.error_code"]).toBe("forbidden");
  });

  it("an invalid input marks input_parse", async () => {
    const reg = registry("children");
    reg.register(tool("t", () => ({})));
    await reg.dispatch("t", { nope: 1 }, ctx());
    const p = byName("input_parse")[0];
    expect(errored(p)).toBe(true);
    expect(p?.attributes["obsidian_tc.error_code"]).toBe("validation_error");
    expect(names()).not.toContain("auth_check");
  });

  it("a typed handler error marks tool_impl with that code and never the message", async () => {
    const reg = registry("verbose");
    reg.register(
      tool("t", () => {
        throw new ObsidianTcError("not_found", `no such note ${DENIED_PATH}`);
      }),
    );
    await reg.dispatch("t", {}, ctx());
    const impl = byName("tool_impl")[0];
    expect(errored(impl)).toBe(true);
    expect(impl?.attributes["obsidian_tc.error_code"]).toBe("not_found");
    expect(impl?.status.message).toBe("not_found");
    expect(impl?.events).toEqual([]);
    expect(names()).not.toContain("output_serialize");
  });

  it("an untyped handler throw is recorded as the redacted internal code, not its message", async () => {
    const reg = registry("verbose");
    reg.register(
      tool("t", () => {
        throw new Error(`boom ${SECRET}`);
      }),
    );
    await reg.dispatch("t", {}, ctx());
    const impl = byName("tool_impl")[0];
    expect(impl?.attributes["obsidian_tc.error_code"]).toBe("internal");
    expect(JSON.stringify(exporter.getFinishedSpans().map(dump))).not.toContain(SECRET);
  });

  it("an over-budget result marks output_serialize with the overflow code", async () => {
    const reg = registry("children", { maxResponseBytes: 50 });
    reg.register(tool("t", () => ({ blob: "x".repeat(500) })));
    await reg.dispatch("t", {}, ctx());
    const o = byName("output_serialize")[0];
    expect(errored(o)).toBe(true);
    expect(o?.attributes["obsidian_tc.error_code"]).toBe("overflow");
    expect(errored(byName("tool_impl")[0])).toBe(false);
  });

  it("a failing db transaction span carries the error status but not the message", async () => {
    const db = execDb();
    const reg = registry("verbose");
    reg.register(
      tool("t", () =>
        inTransaction(db, () => {
          throw new Error(`sql failure ${SECRET}`);
        }),
      ),
    );
    await reg.dispatch("t", {}, ctx());
    const t = byName("db_transaction")[0];
    expect(errored(t)).toBe(true);
    expect(t?.events).toEqual([]);
    expect(JSON.stringify(dump(t as ReadableSpan))).not.toContain(SECRET);
  });
});

function dump(s: ReadableSpan) {
  return {
    name: s.name,
    attributes: s.attributes,
    status: s.status,
    events: s.events,
    links: s.links,
  };
}

describe("no content, path, token or secret ever reaches a span", () => {
  it.each(["children", "verbose"] as const)(
    "scans every attribute of every span (%s)",
    async (d) => {
      const db = execDb();
      const reg = registry(d);
      reg.register(
        tool("read_notes", async (input) => {
          inTransaction(db, () => 1);
          await paginateByBytes<string, { path: string; content: string }>({
            paging: pagingOf(undefined),
            binding: { tool: "read_notes", principal: "agent-x", args: input },
            cursor: undefined,
            items: [DENIED_PATH, "ok.md"],
            produce: (p) => ({ path: p, content: NOTE_BODY }),
            tooLarge: (p) => ({ path: p, content: "" }),
            frame: (entries) => ({ entries }),
          });
          return { content: NOTE_BODY, path: DENIED_PATH, token: SECRET };
        }),
      );
      // Also a denial: ACL-denied path must not surface in any span.
      reg.register({
        ...tool("denied", () => {
          throw new ObsidianTcError("acl_denied", `denied ${DENIED_PATH}`, { path: DENIED_PATH });
        }),
      });
      const c = ctx({ elicitToken: SECRET, caller: `caller-${SECRET}` });
      await reg.dispatch("read_notes", { q: `${SECRET} ${NOTE_BODY} ${DENIED_PATH}` }, c);
      await reg.dispatch("denied", { q: DENIED_PATH }, c);
      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(d === "verbose" ? 10 : 8); // floor: a scan over nothing proves nothing
      const blob = JSON.stringify(spans.map(dump));
      for (const needle of [SECRET, NOTE_BODY, DENIED_PATH, "secret-plans", "denied-folder"])
        expect(blob).not.toContain(needle);
      for (const s of spans) expect(s.events).toEqual([]);
    },
  );
});

describe("concurrent requests never cross-parent", () => {
  it("interleaved dispatches keep every stage under its own request's root", async () => {
    const reg = registry("verbose");
    const gate = (ms: number) => new Promise((r) => setTimeout(r, ms));
    reg.register(
      tool("slow", async (input: { q?: string }) => {
        await gate(input.q === "a" ? 15 : 1);
        await traceItem("batch_item", async () => gate(input.q === "a" ? 1 : 10));
        return { ok: input.q };
      }),
    );
    await Promise.all(
      ["a", "b", "c", "d"].map((q) => reg.dispatch("slow", { q }, ctx({ caller: `caller-${q}` }))),
    );
    const roots = exporter.getFinishedSpans().filter((s) => s.name === "obsidian_tc.slow");
    expect(roots).toHaveLength(4);
    const rootIds = new Set(roots.map((r) => r.spanContext().spanId));
    expect(rootIds.size).toBe(4);
    const kids = exporter.getFinishedSpans().filter((s) => s.parentSpanContext !== undefined);
    // 6 stages + 1 item per request
    expect(kids).toHaveLength(4 * (STAGES.length + 1));
    const stageIds = new Map(kids.map((k) => [k.spanContext().spanId, k]));
    for (const k of kids) {
      const owner = roots.find((r) => r.spanContext().traceId === k.spanContext().traceId);
      expect(owner).toBeDefined();
      const p = parentOf(k) as string;
      // every parent is either this request's root or this request's tool_impl stage
      const parentSpan = p === owner?.spanContext().spanId ? owner : stageIds.get(p);
      expect(parentSpan?.spanContext().traceId).toBe(k.spanContext().traceId);
    }
    // each item span hangs off the tool_impl of its OWN trace
    for (const item of byName("batch_item")) {
      const impl = byName("tool_impl").find((s) => s.spanContext().spanId === parentOf(item));
      expect(impl?.spanContext().traceId).toBe(item.spanContext().traceId);
    }
  });
});
