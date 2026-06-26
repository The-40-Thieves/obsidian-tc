import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { RateLimiter } from "../src/throttle";

const fakeDb = { prepare: () => ({ run: () => undefined }) } as unknown as Database;

// elicitToken + verifyElicit:()=>true so HITL-floored classes (bulk/execute) reach the gate.
const ctx = (now: () => number, o: Partial<CallerContext> = {}): CallerContext => ({
  caller: "c",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "main",
  db: fakeDb,
  now,
  elicitToken: "tok",
  ...o,
});

const tool = (name: string, requiredScopes: string[]) => ({
  name,
  description: "",
  inputSchema: z.object({}).strict(),
  requiredScopes,
  handler: () => ({ ok: 1 }),
});

function reg() {
  return new ToolRegistry({ rateLimiter: new RateLimiter(), verifyElicit: () => true });
}

describe("dispatch-wide rate limiter (THE-210)", () => {
  it("throttles each scope class at its own tier, independently (fixed clock)", async () => {
    const r = reg();
    r.register(tool("read_note", ["read:notes"]));
    r.register(tool("bulk_create_notes", ["write:notes", "bulk:notes"]));
    r.register(tool("exec", ["execute:shell"]));
    r.register(tool("admin_op", ["admin:server"]));
    const now = () => 0; // frozen -> no refill

    // bulk tier: burst 3
    for (let i = 0; i < 3; i++) {
      expect((await r.dispatch("bulk_create_notes", {}, ctx(now))).ok).toBe(true);
    }
    expect((await r.dispatch("bulk_create_notes", {}, ctx(now))).ok).toBe(false);

    // execute tier: burst 1, independent bucket
    expect((await r.dispatch("exec", {}, ctx(now))).ok).toBe(true);
    expect((await r.dispatch("exec", {}, ctx(now))).ok).toBe(false);

    // admin tier: burst 1, independent of execute
    expect((await r.dispatch("admin_op", {}, ctx(now))).ok).toBe(true);
    expect((await r.dispatch("admin_op", {}, ctx(now))).ok).toBe(false);

    // read tier (burst 100) is its own bucket -> unaffected
    for (let i = 0; i < 10; i++) {
      expect((await r.dispatch("read_note", {}, ctx(now))).ok).toBe(true);
    }
  });

  it("returns the G2.4 throttle detail fields (scope_class, rate, retry_after)", async () => {
    const r = reg();
    r.register(tool("exec", ["execute:shell"]));
    const now = () => 0;
    await r.dispatch("exec", {}, ctx(now)); // consume the single burst token
    const res = await r.dispatch("exec", {}, ctx(now));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("throttled");
      expect(res.error.details).toMatchObject({ scope_class: "execute", current_rate: 5 });
      const retry = (res.error.details as { retry_after_seconds: number }).retry_after_seconds;
      expect(typeof retry).toBe("number");
    }
  });

  it("does not throttle when no limiter is configured", async () => {
    const r = new ToolRegistry();
    r.register(tool("read_note", ["read:notes"]));
    for (let i = 0; i < 200; i++) {
      expect(
        (
          await r.dispatch(
            "read_note",
            {},
            ctx(() => 0),
          )
        ).ok,
      ).toBe(true);
    }
  });

  it("throttles a delete-only tool at the delete tier (burst 20, THE-212)", async () => {
    const r = reg();
    r.register(tool("delete_thing", ["delete:notes"]));
    const now = () => 0; // frozen -> no refill
    for (let i = 0; i < 20; i++) {
      expect((await r.dispatch("delete_thing", {}, ctx(now))).ok).toBe(true);
    }
    const res = await r.dispatch("delete_thing", {}, ctx(now));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("throttled");
      expect(res.error.details).toMatchObject({ scope_class: "delete", current_rate: 60 });
    }
  });

  it("rate-limits before HITL, so a throttled call never consumes the elicit token", async () => {
    // The throttle gate runs before HITL: a rate-limited destructive call is rejected
    // without verifyElicit being invoked, so the single-use confirmation survives for a
    // backed-off retry. (Under the old HITL-before-throttle order this spy would fire twice.)
    let elicitChecks = 0;
    const r = new ToolRegistry({
      rateLimiter: new RateLimiter(),
      verifyElicit: () => {
        elicitChecks++;
        return true;
      },
    });
    r.register(tool("exec", ["execute:shell"])); // execute tier: burst 1, HITL-floored
    const now = () => 0; // frozen -> no refill

    // First call clears the throttle gate (consumes the single burst token) then HITL.
    expect((await r.dispatch("exec", {}, ctx(now))).ok).toBe(true);
    expect(elicitChecks).toBe(1);

    // Second call is throttled BEFORE HITL — the elicit token is never checked/consumed.
    const res = await r.dispatch("exec", {}, ctx(now));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("throttled");
    expect(elicitChecks).toBe(1);
  });
});
