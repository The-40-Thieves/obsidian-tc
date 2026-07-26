// THE-514: the AbortSignal slice. CallerContext.signal is threaded from the transport (MCP SDK
// extra.signal, or a caller-supplied AbortController) into runDispatch, which checks it
// cooperatively at a few stage boundaries and immediately before def.handler runs. These tests
// pin the caller-visible contract:
//
//   - an already-aborted signal never invokes the handler
//   - a signal that aborts mid-pipeline stops at the next boundary, before the handler
//   - no signal at all behaves exactly as before (regression pin)
//   - aborting after an idempotency claim is taken releases the claim, so a legitimate retry
//     re-runs rather than being stuck in-flight or wrongly marked indeterminate
//
// Handlers honouring the signal mid-execution is explicitly out of scope here (follow-up).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function ctx(db: Database, over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["write:notes", "delete:notes"]),
    vaultId: "v1",
    db,
    ...over,
  };
}

function idemRow(db: Database, key: string) {
  return db.prepare("SELECT * FROM idempotency_keys WHERE vault_id='v1' AND key=?").get(key) as
    | { state: string }
    | undefined;
}

describe("THE-514: AbortSignal threads through runDispatch", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("an already-aborted signal never invokes the handler", async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(() => ({ ok: true }));
    registry.register({
      name: "plain",
      description: "d",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler,
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await registry.dispatch("plain", {}, ctx(db, { signal: ctrl.signal }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("aborted");
    expect(handler).not.toHaveBeenCalled();
  });

  it("a signal that aborts mid-pipeline stops before the handler runs", async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(() => ({ ok: true }));
    const ctrl = new AbortController();
    registry.register({
      name: "aborts_in_precheck",
      description: "d",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      // Fires after entry but before the next checked boundary — the signal was NOT aborted
      // when dispatch started, so this proves a MID-pipeline abort is caught, not just an
      // already-aborted one.
      precheck: () => {
        ctrl.abort();
      },
      handler,
    });
    expect(ctrl.signal.aborted).toBe(false);
    const res = await registry.dispatch("aborts_in_precheck", {}, ctx(db, { signal: ctrl.signal }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("aborted");
    expect(handler).not.toHaveBeenCalled();
  });

  it("with no signal at all, dispatch behaves exactly as before (regression pin)", async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(() => ({ ok: true, n: 1 }));
    registry.register({
      name: "plain",
      description: "d",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler,
    });
    const res = await registry.dispatch("plain", {}, ctx(db)); // ctx.signal is undefined
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ ok: true, n: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("aborting right after an idempotency claim releases it, so a retry re-runs the handler", async () => {
    const registry = new ToolRegistry();
    const ctrl = new AbortController();
    let calls = 0;
    registry.register({
      name: "keyed",
      description: "keyed write",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      // Runs BEFORE the idempotency claim; the claim is taken normally, and the very next
      // boundary check (after the idempotency gate, before the handler) is what actually
      // catches this abort.
      precheck: () => {
        ctrl.abort();
      },
      handler: () => {
        calls += 1;
        return { ok: true };
      },
    });
    const first = await registry.dispatch(
      "keyed",
      { idempotency_key: "K" },
      ctx(db, { signal: ctrl.signal }),
    );
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("aborted");
    expect(calls).toBe(0); // handler never ran: nothing was committed
    // The claim must be released (not left in_flight, effect_committed, or indeterminate) —
    // an abort before the handler ran is a pre-effect fault, so a legitimate retry may re-run.
    expect(idemRow(db, "K")).toBeUndefined();

    const retry = await registry.dispatch("keyed", { idempotency_key: "K" }, ctx(db)); // fresh, no signal
    expect(retry.ok).toBe(true);
    expect(calls).toBe(1); // the retry actually ran the handler, exactly once
  });

  it("the LAST checkpoint immediately before the handler also fires, independent of earlier ones", async () => {
    // Drives the abort through the HITL gate's verifyElicit callback — the only synchronous hook
    // between the idempotency/throttle boundary and the handler invocation — so this exercises
    // the checkpoint right before `def.handler(...)`, not the earlier ones.
    const ctrl = new AbortController();
    let shouldAbort = true;
    const registry = new ToolRegistry({
      verifyElicit: (token, hash) => {
        if (shouldAbort) ctrl.abort();
        return token === `good:${hash}`;
      },
    });
    const handler = vi.fn(() => ({ deleted: true }));
    registry.register({
      name: "danger",
      description: "destructive",
      inputSchema: z.object({}).strict(),
      requiredScopes: ["delete:notes"],
      destructive: true,
      handler,
    });
    const hash = argsHash("danger", {});
    const res = await registry.dispatch(
      "danger",
      {},
      ctx(db, { elicitToken: `good:${hash}`, signal: ctrl.signal }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("aborted");
    expect(handler).not.toHaveBeenCalled();

    // Retry, unaborted: proves the earlier boundaries alone would have let this through, so it
    // really was the last checkpoint that caught the aborted attempt above.
    shouldAbort = false;
    const retry = await registry.dispatch("danger", {}, ctx(db, { elicitToken: `good:${hash}` }));
    expect(retry.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
