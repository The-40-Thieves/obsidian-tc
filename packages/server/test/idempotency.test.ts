import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { argsHash } from "../src/hash";
import { type CallerContext, type RegistryOptions, ToolRegistry } from "../src/mcp/registry";
import { MetricsRecorder } from "../src/metrics/registry";
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

// A keyed write tool that counts how many times its handler actually runs.
function counterReg(opts: RegistryOptions = {}) {
  const reg = new ToolRegistry(opts);
  const calls = { n: 0 };
  reg.register({
    name: "kv_put",
    description: "keyed write",
    inputSchema: z.object({
      k: z.string(),
      v: z.string(),
      idempotency_key: z.string().optional(),
    }),
    requiredScopes: ["write:notes"],
    handler: (input: { k: string; v: string }) => {
      calls.n += 1;
      return { stored: `${input.k}=${input.v}`, n: calls.n };
    },
  });
  return { reg, calls };
}

type IdemRow = {
  tool_name: string;
  args_hash: string;
  started_at: number;
  completed_at: number | null;
  result: unknown;
  result_size: number | null;
  expires_at: number;
};

function idemRow(db: Database, key: string): IdemRow | undefined {
  return db
    .prepare("SELECT * FROM idempotency_keys WHERE vault_id = ? AND key = ?")
    .get("v1", key) as IdemRow | undefined;
}

const INSERT =
  "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?,?,?,?,?,?,?,?,?)";

describe("dispatch idempotency gate (D3)", () => {
  it("first keyed call executes and stores a completed row", async () => {
    const db = freshDb();
    const { reg, calls } = counterReg();
    const r = await reg.dispatch("kv_put", { k: "a", v: "1", idempotency_key: "K1" }, ctx(db));
    expect(r.ok).toBe(true);
    expect(calls.n).toBe(1);
    const row = idemRow(db, "K1");
    expect(row?.completed_at).not.toBeNull();
    expect(row?.tool_name).toBe("kv_put");
  });

  it("replays the cached result without re-running the handler", async () => {
    const db = freshDb();
    const { reg, calls } = counterReg();
    const a = await reg.dispatch("kv_put", { k: "a", v: "1", idempotency_key: "K" }, ctx(db));
    const b = await reg.dispatch("kv_put", { k: "a", v: "1", idempotency_key: "K" }, ctx(db));
    expect(a.ok && b.ok).toBe(true);
    expect(calls.n).toBe(1);
    if (a.ok && b.ok) expect(b.data).toEqual(a.data);
  });

  it("rejects the same key with different args (mismatch)", async () => {
    const db = freshDb();
    const { reg } = counterReg();
    await reg.dispatch("kv_put", { k: "a", v: "1", idempotency_key: "K" }, ctx(db));
    const r = await reg.dispatch("kv_put", { k: "a", v: "2", idempotency_key: "K" }, ctx(db));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("idempotency_key_mismatch");
  });

  it("rejects the same key used by a different tool (mismatch)", async () => {
    const db = freshDb();
    const { reg } = counterReg();
    reg.register({
      name: "other",
      description: "other keyed",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => ({ ok: true }),
    });
    await reg.dispatch("kv_put", { k: "a", v: "1", idempotency_key: "K" }, ctx(db));
    const r = await reg.dispatch("other", { idempotency_key: "K" }, ctx(db));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("idempotency_key_mismatch");
  });

  it("rejects an overlapping in-flight key", async () => {
    const db = freshDb();
    const { reg } = counterReg();
    const now = 1_000_000;
    db.prepare(INSERT).run(
      "v1",
      "K",
      "kv_put",
      argsHash("kv_put", { k: "a", v: "1", idempotency_key: "K" }),
      now,
      null,
      null,
      null,
      now + 86_400_000,
    );
    const r = await reg.dispatch(
      "kv_put",
      { k: "a", v: "1", idempotency_key: "K" },
      ctx(db, { now: () => now + 5_000 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("idempotency_in_flight");
  });

  it("reclaims a crashed in-flight row past the 60s sweep window", async () => {
    const db = freshDb();
    const { reg, calls } = counterReg();
    const now = 2_000_000;
    db.prepare(INSERT).run("v1", "K", "kv_put", "stale", now, null, null, null, now + 86_400_000);
    const r = await reg.dispatch(
      "kv_put",
      { k: "a", v: "1", idempotency_key: "K" },
      ctx(db, { now: () => now + 61_000 }),
    );
    expect(r.ok).toBe(true);
    expect(calls.n).toBe(1);
    expect(idemRow(db, "K")?.completed_at).not.toBeNull();
  });

  it("a failed handler releases the slot so a retry can run", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let n = 0;
    reg.register({
      name: "flaky",
      description: "throws once",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return { ok: true };
      },
    });
    const a = await reg.dispatch("flaky", { idempotency_key: "K" }, ctx(db));
    expect(a.ok).toBe(false);
    expect(idemRow(db, "K")).toBeUndefined();
    const b = await reg.dispatch("flaky", { idempotency_key: "K" }, ctx(db));
    expect(b.ok).toBe(true);
  });

  it("a tool without a key runs every time and never touches the table", async () => {
    const db = freshDb();
    const { reg, calls } = counterReg();
    await reg.dispatch("kv_put", { k: "a", v: "1" }, ctx(db));
    await reg.dispatch("kv_put", { k: "a", v: "1" }, ctx(db));
    expect(calls.n).toBe(2);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM idempotency_keys").get() as { c: number })
      .c;
    expect(count).toBe(0);
  });

  it("extracts a nested options.idempotency_key", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let n = 0;
    reg.register({
      name: "wopts",
      description: "write options key",
      inputSchema: z.object({
        options: z.object({ idempotency_key: z.string().optional() }).optional(),
      }),
      requiredScopes: ["write:notes"],
      handler: () => {
        n += 1;
        return { n };
      },
    });
    await reg.dispatch("wopts", { options: { idempotency_key: "K" } }, ctx(db));
    await reg.dispatch("wopts", { options: { idempotency_key: "K" } }, ctx(db));
    expect(n).toBe(1);
  });

  it("extracts the bulk_idempotency_key alias", async () => {
    const db = freshDb();
    const reg = new ToolRegistry();
    let n = 0;
    reg.register({
      name: "wbulk",
      description: "bulk key",
      inputSchema: z.object({ bulk_idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        n += 1;
        return { n };
      },
    });
    await reg.dispatch("wbulk", { bulk_idempotency_key: "K" }, ctx(db));
    await reg.dispatch("wbulk", { bulk_idempotency_key: "K" }, ctx(db));
    expect(n).toBe(1);
  });

  it("honors the configured TTL on the claimed row", async () => {
    const db = freshDb();
    const { reg } = counterReg({ idempotencyTtlSeconds: 10 });
    const now = 5_000_000;
    await reg.dispatch(
      "kv_put",
      { k: "a", v: "1", idempotency_key: "K" },
      ctx(db, { now: () => now }),
    );
    expect(idemRow(db, "K")?.expires_at).toBe(now + 10_000);
  });

  it("treats an expired completed row as a miss and re-executes", async () => {
    const db = freshDb();
    const { reg, calls } = counterReg();
    const now = 6_000_000;
    db.prepare(INSERT).run(
      "v1",
      "K",
      "kv_put",
      argsHash("kv_put", { k: "a", v: "1", idempotency_key: "K" }),
      now - 100_000,
      now - 90_000,
      JSON.stringify({ stored: "old", n: 0 }),
      20,
      now - 1_000,
    );
    const r = await reg.dispatch(
      "kv_put",
      { k: "a", v: "1", idempotency_key: "K" },
      ctx(db, { now: () => now }),
    );
    expect(r.ok).toBe(true);
    expect(calls.n).toBe(1);
  });
});

describe("dispatch idempotency metrics (THE-197)", () => {
  it("records an idempotency hit on cache replay", async () => {
    const db = freshDb();
    const metrics = new MetricsRecorder();
    const { reg } = counterReg({ metrics });
    await reg.dispatch("kv_put", { k: "a", v: "1", idempotency_key: "K" }, ctx(db));
    await reg.dispatch("kv_put", { k: "a", v: "1", idempotency_key: "K" }, ctx(db));
    const text = await metrics.metrics();
    expect(text).toContain('obsidian_tc_idempotency_hits_total{vault="v1",tool="kv_put"} 1');
  });

  it("records a cache-skip when a keyed result overflows the byte cap", async () => {
    const db = freshDb();
    const metrics = new MetricsRecorder();
    const reg = new ToolRegistry({ metrics, maxResponseBytes: 10 });
    reg.register({
      name: "big_keyed",
      description: "big keyed write",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => ({ blob: "x".repeat(1000) }),
    });
    const r = await reg.dispatch("big_keyed", { idempotency_key: "K" }, ctx(db));
    expect(r.ok).toBe(false);
    const text = await metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_idempotency_cache_skipped_total{vault="v1",tool="big_keyed"} 1',
    );
  });

  it("replays the overflow error on retry without re-executing the committed effect", async () => {
    const db = freshDb();
    const metrics = new MetricsRecorder();
    let runs = 0;
    const reg = new ToolRegistry({ metrics, maxResponseBytes: 10 });
    reg.register({
      name: "big_keyed2",
      description: "big keyed write with a side effect",
      inputSchema: z.object({ idempotency_key: z.string().optional() }),
      requiredScopes: ["write:notes"],
      handler: () => {
        runs += 1;
        return { blob: "x".repeat(1000) };
      },
    });
    const first = await reg.dispatch("big_keyed2", { idempotency_key: "K" }, ctx(db));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("overflow");
    expect(runs).toBe(1);
    // retry with the same key: the committed effect must NOT run again; replay the overflow error.
    const second = await reg.dispatch("big_keyed2", { idempotency_key: "K" }, ctx(db));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("overflow");
    expect(runs).toBe(1);
  });
});

describe("idempotency reclaim window (THE-293)", () => {
  it("reclaims a crashed in-flight row after the configured window", async () => {
    const db = freshDb();
    const { reg, calls } = counterReg({ idempotencyReclaimSeconds: 5 });
    const now = 7_000_000;
    db.prepare(INSERT).run(
      "v1",
      "K",
      "kv_put",
      argsHash("kv_put", { k: "a", v: "1", idempotency_key: "K" }),
      now - 6_000,
      null,
      null,
      null,
      now + 86_400_000,
    );
    const r = await reg.dispatch(
      "kv_put",
      { k: "a", v: "1", idempotency_key: "K" },
      ctx(db, { now: () => now }),
    );
    expect(r.ok).toBe(true);
    expect(calls.n).toBe(1);
  });

  it("keeps the 60s default: a 6s-old in-flight row still blocks", async () => {
    const db = freshDb();
    const { reg } = counterReg();
    const now = 8_000_000;
    db.prepare(INSERT).run(
      "v1",
      "K",
      "kv_put",
      argsHash("kv_put", { k: "a", v: "1", idempotency_key: "K" }),
      now - 6_000,
      null,
      null,
      null,
      now + 86_400_000,
    );
    const r = await reg.dispatch(
      "kv_put",
      { k: "a", v: "1", idempotency_key: "K" },
      ctx(db, { now: () => now }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("idempotency_in_flight");
  });
});
