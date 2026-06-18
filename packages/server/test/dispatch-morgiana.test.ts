import type { MorgianaEventData, MorgianaEventType } from "@obsidian-tc/shared";
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

function collector() {
  const events: Array<{ type: MorgianaEventType; data: Partial<MorgianaEventData> }> = [];
  const emit = (_v: string, type: MorgianaEventType, data: Partial<MorgianaEventData>) =>
    events.push({ type, data });
  return { events, emit, types: () => events.map((e) => e.type) };
}

describe("dispatch -> MORGIANA events (THE-183)", () => {
  it("emits tc.tool.call.completed (status ok) on a successful call", async () => {
    const c = collector();
    const reg = new ToolRegistry({ emit: c.emit });
    reg.register(tool("read_note", ["read:notes"], () => ({ ok: 1 })));
    await reg.dispatch("read_note", {}, ctx());
    expect(c.types()).toEqual(["tc.tool.call.completed"]);
    expect(c.events[0]?.data.status).toBe("ok");
  });

  it("emits tc.acl.denied alongside completion on a missing-scope forbidden", async () => {
    const c = collector();
    const reg = new ToolRegistry({ emit: c.emit });
    reg.register(tool("update_frontmatter", ["write:meta"], () => ({})));
    await reg.dispatch("update_frontmatter", {}, ctx({ grantedScopes: new Set(["read:notes"]) }));
    expect(c.types()).toEqual(["tc.tool.call.completed", "tc.acl.denied"]);
  });

  it("emits tc.elicit.requested when an elicit token is required and absent", async () => {
    const c = collector();
    const reg = new ToolRegistry({ emit: c.emit, verifyElicit: () => false });
    reg.register(tool("bulk_delete_notes", ["write:notes", "bulk:notes"], () => ({})));
    await reg.dispatch("bulk_delete_notes", {}, ctx({ elicitToken: null }));
    expect(c.types()).toContain("tc.elicit.requested");
  });

  it("emits tc.elicit.consumed when a valid elicit token clears HITL", async () => {
    const c = collector();
    const reg = new ToolRegistry({ emit: c.emit, verifyElicit: () => true });
    reg.register(tool("bulk_create_notes", ["write:notes", "bulk:notes"], () => ({ done: 1 })));
    await reg.dispatch("bulk_create_notes", {}, ctx({ elicitToken: "tok" }));
    expect(c.types()).toEqual(["tc.elicit.consumed", "tc.tool.call.completed"]);
  });

  it("emits tc.governor.overflow on an oversized response", async () => {
    const c = collector();
    const reg = new ToolRegistry({ emit: c.emit, maxResponseBytes: 10 });
    reg.register(tool("big", [], () => ({ blob: "x".repeat(1000) })));
    await reg.dispatch("big", {}, ctx());
    expect(c.types()).toEqual(["tc.tool.call.completed", "tc.governor.overflow"]);
  });

  it("emits tc.vault.cache_reset for the reset_vault_cache tool", async () => {
    const c = collector();
    const reg = new ToolRegistry({ emit: c.emit });
    reg.register(tool("reset_vault_cache", ["admin:vault"], () => ({ reset: true })));
    await reg.dispatch("reset_vault_cache", {}, ctx());
    expect(c.types()).toEqual(["tc.tool.call.completed", "tc.vault.cache_reset"]);
  });

  it("never throws when no emit sink is configured", async () => {
    const reg = new ToolRegistry();
    reg.register(tool("noop", [], () => ({})));
    expect((await reg.dispatch("noop", {}, ctx())).ok).toBe(true);
  });
});
