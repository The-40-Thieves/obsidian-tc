// conventionsScope's dispatch gate: the sink is consulted only for a tool whose output schema declares
// `conventions`, so every other mutating tool pays nothing (no stats, no snapshot).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { conventionsScope } from "../src/mcp/registry/conventions-scope";
import type { CallerContext, ConventionsSink, ToolDefinition } from "../src/mcp/registry/types";

const spy = () => {
  const begins: string[] = [];
  const sink: ConventionsSink = {
    begin: async (def) => {
      begins.push(def.name);
      return {};
    },
    check: async () => undefined,
  };
  return { sink, begins };
};

const ctx = { vaultId: "test" } as unknown as CallerContext;
const def = (name: string, shape: Record<string, z.ZodType>): ToolDefinition =>
  ({ name, outputSchema: z.object(shape) }) as unknown as ToolDefinition;

describe("conventionsScope dispatch gate", () => {
  it("begin is a no-op for a tool whose output schema has no conventions key", async () => {
    const { sink, begins } = spy();
    const scope = conventionsScope(sink, () => "/root", undefined, 1e6);
    await scope.begin(def("append_thing", { path: z.string() }), { path: "a.md" }, ctx);
    expect(begins).toEqual([]);
  });

  it("begin consults the sink for a tool whose output schema declares conventions", async () => {
    const { sink, begins } = spy();
    const scope = conventionsScope(sink, () => "/root", undefined, 1e6);
    const write = def("write_note", { path: z.string(), conventions: z.object({}).optional() });
    await scope.begin(write, { path: "a.md" }, ctx);
    expect(begins).toEqual(["write_note"]);
  });

  it("a handler noteWritten call gets that note checked", async () => {
    let judged: ReadonlySet<string> | undefined;
    const sink: ConventionsSink = {
      begin: async () => ({}),
      check: async (_pending, _result, _ctx, _root, noted) => {
        judged = noted;
        return undefined;
      },
    };
    const scope = conventionsScope(sink, () => "/root", undefined, 1e6);
    const write = def("write_note", { path: z.string(), conventions: z.object({}).optional() });
    const call = { vaultId: "test" } as unknown as CallerContext;
    await scope.begin(write, { path: "a.md" }, call);
    call.noteWritten?.("meetings/x.md");
    await scope.annotate(write, { path: "a.md" }, call);
    expect([...(judged ?? [])]).toEqual(["meetings/x.md"]);
  });

  it("abandon uninstalls noteWritten when the handler throws", async () => {
    const { sink } = spy();
    const scope = conventionsScope(sink, () => "/root", undefined, 1e6);
    const write = def("write_note", { path: z.string(), conventions: z.object({}).optional() });
    const call = { vaultId: "test" } as unknown as CallerContext;
    await scope.begin(write, { path: "a.md" }, call);
    expect(call.noteWritten).toBeDefined();
    scope.abandon(call);
    expect(call.noteWritten).toBeUndefined();
  });
});
