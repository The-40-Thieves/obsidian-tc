// withIndexFlush's collector: records made during a call are flushed to the index hooks after a
// successful return, superseded per key (a write cancels a delete and the reverse), never flushed
// on a throw, and a nested wrapped call on the same ctx keeps the outer call's records.
import { describe, expect, it, vi } from "vitest";
import type { CallerContext } from "../src/mcp/registry";
import type { ToolDefinition } from "../src/mcp/registry/types";
import {
  recordIndexDelete,
  recordIndexWrite,
  withIndexFlush,
} from "../src/tools/m5/memory-projection";
import type { M5Deps } from "../src/tools/m5/shared";

type Handler = (input: unknown, ctx: CallerContext) => unknown;

function fakeTool(handler: Handler): ToolDefinition {
  return { name: "fake_tool", handler } as unknown as ToolDefinition;
}

function setup() {
  const reindex = vi.fn();
  const deindex = vi.fn();
  const deps = { reindex, deindex } as unknown as M5Deps;
  const ctx = { caller: "test" } as unknown as CallerContext;
  return { reindex, deindex, deps, ctx };
}

function run(tool: ToolDefinition, ctx: CallerContext): unknown {
  return (tool.handler as Handler)({}, ctx);
}

describe("withIndexFlush collector rules", () => {
  it("flushes each recorded write and delete once after a successful return", () => {
    const { reindex, deindex, deps, ctx } = setup();
    const tool = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/a.md", "A");
        recordIndexDelete(c, "v", "memory/b.md");
        return "ok";
      }),
    );
    expect(run(tool, ctx)).toBe("ok");
    expect(reindex.mock.calls).toEqual([["v", "memory/a.md", "A"]]);
    expect(deindex.mock.calls).toEqual([["v", "memory/b.md"]]);
  });

  it("a handler that records then throws flushes nothing", () => {
    const { reindex, deindex, deps, ctx } = setup();
    const tool = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/a.md", "A");
        recordIndexDelete(c, "v", "memory/b.md");
        throw new Error("rolled back");
      }),
    );
    expect(() => run(tool, ctx)).toThrow("rolled back");
    expect(reindex).not.toHaveBeenCalled();
    expect(deindex).not.toHaveBeenCalled();
  });

  it("an async handler that records then rejects flushes nothing", async () => {
    const { reindex, deindex, deps, ctx } = setup();
    const tool = withIndexFlush(
      deps,
      fakeTool(async (_i, c) => {
        recordIndexWrite(c, "v", "memory/a.md", "A");
        recordIndexDelete(c, "v", "memory/b.md");
        throw new Error("rolled back");
      }),
    );
    await expect(run(tool, ctx) as Promise<unknown>).rejects.toThrow("rolled back");
    expect(reindex).not.toHaveBeenCalled();
    expect(deindex).not.toHaveBeenCalled();
  });

  it("write then delete of the same key flushes only the delete", () => {
    const { reindex, deindex, deps, ctx } = setup();
    const tool = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/a.md", "A");
        recordIndexDelete(c, "v", "memory/a.md");
      }),
    );
    run(tool, ctx);
    expect(reindex).not.toHaveBeenCalled();
    expect(deindex.mock.calls).toEqual([["v", "memory/a.md"]]);
  });

  it("delete then write of the same key flushes only the write", () => {
    const { reindex, deindex, deps, ctx } = setup();
    const tool = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexDelete(c, "v", "memory/a.md");
        recordIndexWrite(c, "v", "memory/a.md", "A2");
      }),
    );
    run(tool, ctx);
    expect(deindex).not.toHaveBeenCalled();
    expect(reindex.mock.calls).toEqual([["v", "memory/a.md", "A2"]]);
  });

  it("a throwing deindex hook does not stop the reindex flush or fail the call", () => {
    const { reindex, ctx } = setup();
    const deindex = vi.fn(() => {
      throw new Error("deindexer down");
    });
    const throwing = { reindex, deindex } as unknown as M5Deps;
    const tool = withIndexFlush(
      throwing,
      fakeTool((_i, c) => {
        recordIndexDelete(c, "v", "memory/b.md");
        recordIndexWrite(c, "v", "memory/a.md", "A");
        return "ok";
      }),
    );
    expect(run(tool, ctx)).toBe("ok");
    expect(reindex.mock.calls).toEqual([["v", "memory/a.md", "A"]]);
    expect(deindex).toHaveBeenCalledWith("v", "memory/b.md");
  });

  it("nested wrapped calls on one ctx flush each call's own records once", () => {
    const { reindex, deindex, deps, ctx } = setup();
    const inner = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/inner.md", "I");
        recordIndexDelete(c, "v", "memory/inner-gone.md");
      }),
    );
    let flushedAtInnerReturn = -1;
    const outer = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/outer-before.md", "B");
        run(inner, c);
        flushedAtInnerReturn = reindex.mock.calls.length + deindex.mock.calls.length;
        recordIndexWrite(c, "v", "memory/outer-after.md", "A");
        recordIndexDelete(c, "v", "memory/outer-gone.md");
      }),
    );
    run(outer, ctx);
    expect(flushedAtInnerReturn).toBe(0);
    expect(reindex.mock.calls.map((c) => c[1]).sort()).toEqual([
      "memory/inner.md",
      "memory/outer-after.md",
      "memory/outer-before.md",
    ]);
    expect(deindex.mock.calls.map((c) => c[1]).sort()).toEqual([
      "memory/inner-gone.md",
      "memory/outer-gone.md",
    ]);
  });

  it("nested: an inner write supersedes the outer write of the same key, flushed once", () => {
    const { reindex, deindex, deps, ctx } = setup();
    const inner = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/x.md", "INNER");
      }),
    );
    const outer = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/x.md", "OUTER-OLD");
        run(inner, c);
      }),
    );
    run(outer, ctx);
    expect(reindex.mock.calls).toEqual([["v", "memory/x.md", "INNER"]]);
    expect(deindex).not.toHaveBeenCalled();
  });

  it("nested: an inner delete supersedes the outer write of the same key", () => {
    const { reindex, deindex, deps, ctx } = setup();
    const inner = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexDelete(c, "v", "memory/x.md");
      }),
    );
    const outer = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/x.md", "OUTER");
        run(inner, c);
      }),
    );
    run(outer, ctx);
    expect(reindex).not.toHaveBeenCalled();
    expect(deindex.mock.calls).toEqual([["v", "memory/x.md"]]);
  });

  it("nested: an inner success then an outer throw flushes nothing", () => {
    const { reindex, deindex, deps, ctx } = setup();
    const inner = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexDelete(c, "v", "memory/kept-gone.md");
        recordIndexWrite(c, "v", "memory/kept.md", "K");
      }),
    );
    const outer = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        run(inner, c);
        throw new Error("outer rolled back");
      }),
    );
    expect(() => run(outer, ctx)).toThrow("outer rolled back");
    expect(reindex).not.toHaveBeenCalled();
    expect(deindex).not.toHaveBeenCalled();
  });

  it("nested: an inner throw the outer catches drops only the inner records", () => {
    const { reindex, deindex, deps, ctx } = setup();
    const inner = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/inner.md", "I");
        throw new Error("inner failed");
      }),
    );
    const outer = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/outer.md", "O");
        try {
          run(inner, c);
        } catch {
          /* the outer call recovers */
        }
        recordIndexDelete(c, "v", "memory/outer-gone.md");
        return "ok";
      }),
    );
    expect(run(outer, ctx)).toBe("ok");
    expect(reindex.mock.calls).toEqual([["v", "memory/outer.md", "O"]]);
    expect(deindex.mock.calls).toEqual([["v", "memory/outer-gone.md"]]);
  });

  it("an async handler that succeeds flushes once and leaves no collector behind", async () => {
    const { reindex, deps, ctx } = setup();
    const tool = withIndexFlush(
      deps,
      fakeTool(async (_i, c) => {
        recordIndexWrite(c, "v", "memory/a.md", "A");
        return "ok";
      }),
    );
    await expect(run(tool, ctx) as Promise<unknown>).resolves.toBe("ok");
    expect(reindex.mock.calls).toEqual([["v", "memory/a.md", "A"]]);
    const next = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/b.md", "B");
      }),
    );
    run(next, ctx);
    expect(reindex.mock.calls.map((c) => c[1])).toEqual(["memory/a.md", "memory/b.md"]);
  });

  it("a thenable whose then() throws leaves no collector behind on ctx", async () => {
    const { reindex, deps, ctx } = setup();
    const bad = withIndexFlush(
      deps,
      fakeTool(() => ({
        // biome-ignore lint/suspicious/noThenProperty: a thenable is the case under test.
        then() {
          throw new Error("bad then");
        },
      })),
    );
    await expect(Promise.resolve().then(() => run(bad, ctx))).rejects.toThrow("bad then");
    const next = withIndexFlush(
      deps,
      fakeTool((_i, c) => {
        recordIndexWrite(c, "v", "memory/c.md", "C");
      }),
    );
    run(next, ctx);
    expect(reindex.mock.calls).toEqual([["v", "memory/c.md", "C"]]);
  });
});
