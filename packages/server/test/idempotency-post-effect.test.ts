import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import type { Database, Statement } from "../src/db/types";
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
    // THE-741: an indeterminate replay is a REPLAY too — no handler ran on this call — and must
    // carry the same marker as an ok/overflow replay so a caller like `rerun` cannot mistake it
    // for a fresh (if inconclusive) execution.
    expect(b.meta.idempotent_replay).toBe(true);
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

const INSERT_STATE =
  "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at, state) VALUES (?,?,?,?,?,?,?,?,?,?)";

describe("idempotency crash-after-effect (THE-562 #13)", () => {
  it("an orphaned effect_committed row (crash before finalize) replays indeterminate, never re-runs", async () => {
    const db = freshDb();
    const { reg, calls } = (() => {
      const reg = new ToolRegistry();
      const calls = { n: 0 };
      reg.register({
        name: "kv_put",
        description: "keyed write",
        inputSchema: z.object({ k: z.string().optional(), idempotency_key: z.string().optional() }),
        requiredScopes: ["write:notes"],
        handler: () => {
          calls.n += 1;
          return { ok: true };
        },
      });
      return { reg, calls };
    })();
    const now = 3_000_000;
    // simulate a process that set the marker then died before finalize: state='effect_committed',
    // completed_at NULL, well within TTL, and PAST the 60s reclaim window.
    db.prepare(INSERT_STATE).run(
      "v1",
      "K",
      "kv_put",
      // args_hash must match the retry's args so it is not a mismatch:
      (await import("../src/hash")).argsHash("kv_put", { idempotency_key: "K" }),
      now,
      null,
      null,
      null,
      now + 86_400_000,
      "effect_committed",
    );
    const r = await reg.dispatch(
      "kv_put",
      { idempotency_key: "K" },
      ctx(db, { now: () => now + 61_000 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("indeterminate_outcome");
    expect(calls.n).toBe(0); // handler never re-ran
  });

  it("past its TTL, an effect_committed orphan is GC'd and re-runs (bounded at-most-once)", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let n = 0;
    reg.register({
      name: "kv_put",
      description: "keyed write",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        n += 1;
        return { ok: true };
      },
    });
    const { argsHash } = await import("../src/hash");
    const now = 4_000_000;
    db.prepare(INSERT_STATE).run(
      "v1",
      "K",
      "kv_put",
      argsHash("kv_put", { idempotency_key: "K" }),
      now,
      null,
      null,
      null,
      now + 1_000,
      "effect_committed", // expires_at = now+1s
    );
    const r = await reg.dispatch(
      "kv_put",
      { idempotency_key: "K" },
      ctx(db, { now: () => now + 5_000 }),
    ); // past TTL
    expect(r.ok).toBe(true);
    expect(n).toBe(1);
  });

  it("an overflow whose finalize faults leaves effect_committed, so a retry is indeterminate", async () => {
    // Prove the marker is set BEFORE the overflow finalize: if finalize throws, durability survives.
    const base = freshDb();
    let runs = 0;
    const reg = new ToolRegistry({ maxResponseBytes: 10 });
    reg.register({
      name: "big_keyed",
      description: "big keyed write",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        runs += 1;
        return { blob: "x".repeat(1000) };
      },
    });
    // db wrapper that throws on the finalize UPDATE (SET completed_at ... state='completed'),
    // delegating everything else to the real db. cachedPrepare (db/types.ts) uses `prepareCached`
    // when the adapter has it, else `prepare` — intercept BOTH so the throw fires regardless of
    // which the memory adapter exposes.
    const FINALIZE_RE =
      /UPDATE idempotency_keys SET completed_at = \?, result = \?, result_size = \?, state = 'completed'/;
    const wrap = (fn: ((sql: string) => Statement) | undefined) =>
      fn
        ? (sql: string) => {
            const stmt = fn.call(base, sql);
            if (FINALIZE_RE.test(sql)) {
              return {
                ...stmt,
                run: () => {
                  throw new Error("finalize fault");
                },
              } as Statement;
            }
            return stmt;
          }
        : undefined;
    const throwingDb = new Proxy(base, {
      get(target, prop, recv) {
        if (prop === "prepare") return wrap(target.prepare?.bind(target));
        if (prop === "prepareCached") return wrap(target.prepareCached?.bind(target));
        return Reflect.get(target, prop, recv);
      },
    }) as unknown as Database;
    const first = await reg.dispatch("big_keyed", { idempotency_key: "K" }, ctx(throwingDb));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("overflow"); // overflow still returned
    expect(runs).toBe(1);
    expect(idemRow(base, "K")?.state).toBe("effect_committed"); // durable marker survived the fault
    // retry on the real db: indeterminate, not re-run.
    const second = await reg.dispatch("big_keyed", { idempotency_key: "K" }, ctx(base));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("indeterminate_outcome");
    expect(runs).toBe(1);
  });
});
