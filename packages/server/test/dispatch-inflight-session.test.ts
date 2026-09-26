// THE-1108 fix (Codex P1-2): "a session with a request in flight is never closed" needed a
// primitive backing it — `markInFlight`/`inFlightCount` (workspace/sessions.ts) — and a SINGLE
// place that marks/releases it. `ToolRegistry.dispatch` is that place: every dispatch call site in
// this repo (mcp/server.ts, the scheduler's task-call-runner, workspace/rerun.ts,
// cli/commands/prefetch.ts, memory-import/apply.ts via cli/commands/memory-import.ts) funnels
// through it, so one guard here covers all of them rather than one per site (verified with
// `rg -n "\.dispatch\("` before choosing this site — see the coordinator's own brief).
//
// These tests exercise `dispatch()` directly rather than any one call site, since the guarantee is
// about `dispatch()` itself: mark before the handler runs, release in `finally` so a throw still
// releases, and a call with NO sessionId (the common case — most callers never attach one) never
// touches the registry at all.
import type { Tracer } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { inFlightCount } from "../src/workspace/sessions";

function ctx(over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set([]),
    vaultId: "v1",
    db: {} as Database,
    ...over,
  };
}

describe("ToolRegistry.dispatch marks/releases sessionId in-flight — THE-1108 fix", () => {
  it("the session is in flight WHILE the handler runs, and back to 0 immediately after it returns", async () => {
    const registry = new ToolRegistry();
    let seenDuringHandler = -1;
    registry.register({
      name: "observe",
      description: "d",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler: () => {
        seenDuringHandler = inFlightCount("sess_target");
        return { ok: true };
      },
    });
    expect(inFlightCount("sess_target")).toBe(0);
    await registry.dispatch("observe", {}, ctx({ sessionId: "sess_target" }));
    expect(seenDuringHandler).toBe(1);
    expect(inFlightCount("sess_target")).toBe(0);
  });

  it("a handler that throws is caught by dispatch's own error envelope, and still releases", async () => {
    // runDispatch converts a handler throw into an `ok: false` ToolResult rather than rejecting
    // (dispatch's caller-visible contract) — the in-flight release must not depend on which of the
    // two shapes dispatch returns.
    const registry = new ToolRegistry();
    registry.register({
      name: "boom",
      description: "d",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler: () => {
        throw new Error("handler blew up");
      },
    });
    const result = await registry.dispatch("boom", {}, ctx({ sessionId: "sess_throws" }));
    expect(result.ok).toBe(false);
    expect(inFlightCount("sess_throws")).toBe(0);
  });

  it("an unknown tool (fails before the handler ever runs) still releases", async () => {
    const registry = new ToolRegistry();
    const result = await registry.dispatch(
      "does_not_exist",
      {},
      ctx({ sessionId: "sess_unknown_tool" }),
    );
    expect(result.ok).toBe(false);
    expect(inFlightCount("sess_unknown_tool")).toBe(0);
  });

  it("a genuine throw OUTSIDE runDispatch (a broken tracer) still releases — dispatch()'s own try/finally, not runDispatch's envelope, is what covers this", async () => {
    const brokenTracer = {
      startActiveSpan: () => {
        throw new Error("tracer exploded");
      },
    } as unknown as Tracer;
    const registry = new ToolRegistry({ tracer: brokenTracer });
    registry.register({
      name: "plain",
      description: "d",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler: () => ({ ok: true }),
    });
    await expect(
      registry.dispatch("plain", {}, ctx({ sessionId: "sess_tracer_throw" })),
    ).rejects.toThrow("tracer exploded");
    expect(inFlightCount("sess_tracer_throw")).toBe(0);
  });

  it("never touches the registry for a call with no sessionId — the common, untracked case", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "plain",
      description: "d",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler: () => ({ ok: true }),
    });
    // No sessionId on ctx at all — must not throw, and there is nothing to assert an id against.
    await expect(registry.dispatch("plain", {}, ctx())).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it("two concurrent calls sharing one sessionId: the first's release does not un-mark the second's still-running call", async () => {
    const registry = new ToolRegistry();
    let releaseFirst: (() => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    registry.register({
      name: "slow",
      description: "d",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler: async () => {
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { ok: true };
      },
    });
    registry.register({
      name: "fast",
      description: "d",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler: () => ({ ok: true }),
    });
    const first = registry.dispatch("slow", {}, ctx({ sessionId: "sess_shared" }));
    await started;
    expect(inFlightCount("sess_shared")).toBe(1);
    await registry.dispatch("fast", {}, ctx({ sessionId: "sess_shared" }));
    // "fast" released its own mark, but "slow" is still running — must still read 1, not 0.
    expect(inFlightCount("sess_shared")).toBe(1);
    releaseFirst?.();
    await first;
    expect(inFlightCount("sess_shared")).toBe(0);
  });
});
