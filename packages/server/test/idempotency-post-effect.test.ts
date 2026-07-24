import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
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
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
    ...over,
  };
}
function idemRow(db: Database, key: string) {
  return db.prepare("SELECT * FROM idempotency_keys WHERE vault_id='v1' AND key=?").get(key) as
    | { completed_at: number | null; state: string }
    | undefined;
}

describe("idempotency post-effect fault (THE-562 #13)", () => {
  it("a strict-output-schema violation AFTER the effect records indeterminate, not delete", async () => {
    const db = freshDb();
    const reg = new ToolRegistry(); // NODE_ENV=test => strictOutputSchema on
    const eff = { n: 0 };
    reg.register({
      name: "bad_out",
      description: "commits then violates its output schema",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      outputSchema: z.object({ ok: z.literal(true) }),
      requiredScopes: ["write:notes"],
      handler: () => {
        eff.n += 1; // the committed effect
        return { ok: false } as unknown as { ok: true }; // violates outputSchema
      },
    });
    const a = await reg.dispatch("bad_out", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(false); // the CURRENT caller sees the real failure
    expect(eff.n).toBe(1);
    expect(idemRow(db, "K")?.state).toBe("indeterminate"); // claim NOT deleted
    // retry: must NOT re-run; returns indeterminate_outcome
    const b = await reg.dispatch("bad_out", { idempotency_key: "K" }, ctx(db));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe("indeterminate_outcome");
    expect(eff.n).toBe(1); // effect did not double
  });

  it("a JSON.stringify failure AFTER the effect records indeterminate", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    const eff = { n: 0 };
    reg.register({
      name: "unserializable",
      description: "commits then returns a BigInt payload",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        eff.n += 1;
        return { bad: 10n } as unknown as Record<string, unknown>; // JSON.stringify throws on BigInt
      },
    });
    const a = await reg.dispatch("unserializable", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(false);
    expect(eff.n).toBe(1);
    expect(idemRow(db, "K")?.state).toBe("indeterminate");
    const b = await reg.dispatch("unserializable", { idempotency_key: "K" }, ctx(db));
    if (!b.ok) expect(b.error.code).toBe("indeterminate_outcome");
    expect(eff.n).toBe(1);
  });

  it("a PRE-handler failure still deletes the claim (legitimate retry re-runs)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let n = 0;
    reg.register({
      name: "flaky",
      description: "throws before any effect",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        n += 1;
        if (n === 1) throw new Error("boom"); // throws BEFORE committing anything observable
        return { ok: true };
      },
    });
    const a = await reg.dispatch("flaky", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(false);
    expect(idemRow(db, "K")).toBeUndefined(); // deleted — no effect committed
    const b = await reg.dispatch("flaky", { idempotency_key: "K" }, ctx(db));
    expect(b.ok).toBe(true); // retry re-runs
  });
});
