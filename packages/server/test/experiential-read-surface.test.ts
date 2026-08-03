// PR-1 (THE-655 + THE-642 item 2) — the two new agent_episodes read surfaces.
//
// The interesting assertions here are the SECURITY ones, not the happy paths:
//   * work_episode_chain must STOP at a hop it cannot show, never skip it. A returned chain with a
//     gap discloses that a hidden episode exists, which is exactly what THE-655's control-1
//     tombstone rule (and visiblePrevIds) exists to prevent.
//   * the caller partition and P1.7's any_caller scope apply at EVERY hop, not just the entry row.
//   * episode_stats must never let a bucket small enough to identify a single episode through, and
//     must not be able to group by caller at all.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM8Tools } from "../src/tools/m8";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

interface Ep {
  id: string;
  ts?: number;
  caller?: string | null;
  tool?: string;
  status?: string;
  eligibility?: string;
  trust?: number;
  blocked?: number;
  valid_until?: number | null;
  prev_id?: string | null;
}

function seed(db: Database, e: Ep) {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, vault_id, session_id, caller, channel, episode_type,
       tool, status, eligibility, trust, blocked, valid_from, valid_until, prev_id)
     VALUES (?, ?, 'main', NULL, ?, 'dispatch', 'tool_call', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.ts ?? NOW,
    e.caller === undefined ? "tester" : e.caller,
    e.tool ?? "read_note",
    e.status ?? "ok",
    e.eligibility ?? "eligible",
    e.trust ?? 0.6,
    e.blocked ?? 0,
    e.ts ?? NOW,
    e.valid_until ?? null,
    e.prev_id ?? null,
  );
}

function cacheDb0() {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vault_id TEXT, tool_name TEXT, caller TEXT, duration_ms INTEGER, result_size INTEGER, status TEXT NOT NULL, error_code TEXT, args_hash TEXT, event_type TEXT);",
  );
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

function harness(edb?: Database) {
  const registry = new ToolRegistry({});
  registerM8Tools(registry, { ...(edb ? { edb } : {}), now: () => NOW });
  const cache = cacheDb0();
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:workspace", "write:workspace", "read:notes"]),
    vaultId: "main",
    db: cache,
    ...over,
  });
  return { registry, ctx };
}

interface ChainOut {
  available: boolean;
  chain: Array<{ id: string; prev_id: string | null }>;
  truncated: boolean;
}
interface StatsOut {
  available: boolean;
  group_by: string;
  min_bucket: number;
  buckets: Array<{ key: string | null; count: number }>;
  suppressed: number;
  suppressed_buckets: number;
  total: number;
}

describe("work_episode_chain (THE-655)", () => {
  it("walks the amendment chain newest-first in one call", async () => {
    const edb = edb0();
    seed(edb, { id: "e1", ts: NOW - 3000, prev_id: null });
    seed(edb, { id: "e2", ts: NOW - 2000, prev_id: "e1" });
    seed(edb, { id: "e3", ts: NOW - 1000, prev_id: "e2" });
    const { registry, ctx } = harness(edb);
    const out = un<ChainOut>(await registry.dispatch("work_episode_chain", { id: "e3" }, ctx()));
    expect(out.chain.map((c) => c.id)).toEqual(["e3", "e2", "e1"]);
    expect(out.truncated).toBe(false);
  });

  it("STOPS at a tombstoned hop rather than skipping it", async () => {
    // e2 is tombstoned. Skipping it and returning [e3, e1] would tell the caller a hidden episode
    // sits between them — the gap itself is the disclosure. The walk must end at e3.
    const edb = edb0();
    seed(edb, { id: "e1", ts: NOW - 3000, prev_id: null });
    seed(edb, { id: "e2", ts: NOW - 2000, prev_id: "e1", blocked: 1 });
    seed(edb, { id: "e3", ts: NOW - 1000, prev_id: "e2" });
    const { registry, ctx } = harness(edb);
    const out = un<ChainOut>(await registry.dispatch("work_episode_chain", { id: "e3" }, ctx()));
    expect(out.chain.map((c) => c.id)).toEqual(["e3"]);
    // ...and the dangling pointer is nulled, so even the tombstoned id does not leak.
    expect(out.chain[0]?.prev_id).toBeNull();
  });

  it("STOPS at an expired hop", async () => {
    const edb = edb0();
    seed(edb, { id: "e1", ts: NOW - 3000, prev_id: null, valid_until: NOW - 1 });
    seed(edb, { id: "e2", ts: NOW - 1000, prev_id: "e1" });
    const { registry, ctx } = harness(edb);
    const out = un<ChainOut>(await registry.dispatch("work_episode_chain", { id: "e2" }, ctx()));
    expect(out.chain.map((c) => c.id)).toEqual(["e2"]);
  });

  it("does not cross the caller partition mid-walk", async () => {
    const edb = edb0();
    seed(edb, { id: "e1", ts: NOW - 2000, prev_id: null, caller: "someone-else" });
    seed(edb, { id: "e2", ts: NOW - 1000, prev_id: "e1", caller: "tester" });
    const { registry, ctx } = harness(edb);
    const out = un<ChainOut>(await registry.dispatch("work_episode_chain", { id: "e2" }, ctx()));
    expect(out.chain.map((c) => c.id)).toEqual(["e2"]);
    // The entry row is also partitioned: another principal's episode is simply not found.
    const other = un<ChainOut>(await registry.dispatch("work_episode_chain", { id: "e1" }, ctx()));
    expect(other.chain).toEqual([]);
  });

  it("any_caller is refused without admin:workspace and honoured with it (P1.7)", async () => {
    const edb = edb0();
    seed(edb, { id: "e1", ts: NOW - 2000, prev_id: null, caller: "someone-else" });
    seed(edb, { id: "e2", ts: NOW - 1000, prev_id: "e1", caller: "someone-else" });
    const { registry, ctx } = harness(edb);
    const denied = (await registry.dispatch(
      "work_episode_chain",
      { id: "e2", any_caller: true },
      ctx(),
    )) as { ok: boolean; error?: { code: string } };
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("forbidden");
    const elevated = ctx({
      grantedScopes: new Set(["read:workspace", "admin:workspace"]),
    });
    const out = un<ChainOut>(
      await registry.dispatch("work_episode_chain", { id: "e2", any_caller: true }, elevated),
    );
    expect(out.chain.map((c) => c.id)).toEqual(["e2", "e1"]);
  });

  it("terminates on a prev_id cycle instead of looping forever", async () => {
    const edb = edb0();
    seed(edb, { id: "a", ts: NOW - 2000, prev_id: "b" });
    seed(edb, { id: "b", ts: NOW - 1000, prev_id: "a" });
    const { registry, ctx } = harness(edb);
    const out = un<ChainOut>(
      await registry.dispatch("work_episode_chain", { id: "a", k: 100 }, ctx()),
    );
    expect(out.chain.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("reports truncated when the walk stops on k rather than on a chain end", async () => {
    const edb = edb0();
    seed(edb, { id: "e1", ts: NOW - 3000, prev_id: null });
    seed(edb, { id: "e2", ts: NOW - 2000, prev_id: "e1" });
    seed(edb, { id: "e3", ts: NOW - 1000, prev_id: "e2" });
    const { registry, ctx } = harness(edb);
    const cut = un<ChainOut>(
      await registry.dispatch("work_episode_chain", { id: "e3", k: 2 }, ctx()),
    );
    expect(cut.chain.map((c) => c.id)).toEqual(["e3", "e2"]);
    expect(cut.truncated).toBe(true);
  });
});

describe("episode_stats (THE-642 item 2)", () => {
  const many = (edb: Database, tool: string, n: number, from = 0) => {
    for (let i = 0; i < n; i++) seed(edb, { id: `${tool}-${from + i}`, tool, ts: NOW - i });
  };

  it("returns counts grouped by tool, and no episode content", async () => {
    const edb = edb0();
    many(edb, "read_note", 6);
    many(edb, "search_text", 8);
    const { registry, ctx } = harness(edb);
    const out = un<StatsOut>(await registry.dispatch("episode_stats", {}, ctx()));
    expect(out.buckets).toEqual([
      { key: "search_text", count: 8 },
      { key: "read_note", count: 6 },
    ]);
    expect(out.total).toBe(14);
    // No content field of any kind is present on a bucket.
    expect(Object.keys(out.buckets[0] ?? {}).sort()).toEqual(["count", "key"]);
  });

  it("withholds buckets below min_bucket and reports them only as a total", async () => {
    const edb = edb0();
    many(edb, "read_note", 6);
    many(edb, "patch_note", 1); // identifies a single episode
    many(edb, "delete_note", 2);
    const { registry, ctx } = harness(edb);
    const out = un<StatsOut>(await registry.dispatch("episode_stats", { min_bucket: 5 }, ctx()));
    expect(out.buckets.map((b) => b.key)).toEqual(["read_note"]);
    expect(out.suppressed).toBe(3); // 1 + 2
    expect(out.suppressed_buckets).toBe(2);
    expect(out.total).toBe(9); // totals still reconcile
  });

  it("refuses a min_bucket below 2 — a bucket of 1 IS a row read", async () => {
    const edb = edb0();
    many(edb, "read_note", 3);
    const { registry, ctx } = harness(edb);
    const r = (await registry.dispatch("episode_stats", { min_bucket: 1 }, ctx())) as {
      ok: boolean;
    };
    expect(r.ok).toBe(false);
  });

  it("cannot group by caller", async () => {
    const edb = edb0();
    many(edb, "read_note", 6);
    const { registry, ctx } = harness(edb);
    const r = (await registry.dispatch("episode_stats", { group_by: "caller" }, ctx())) as {
      ok: boolean;
    };
    expect(r.ok).toBe(false);
  });

  it("excludes tombstoned and expired rows from the counts", async () => {
    const edb = edb0();
    many(edb, "read_note", 6);
    for (let i = 0; i < 4; i++) seed(edb, { id: `bl-${i}`, tool: "read_note", blocked: 1 });
    for (let i = 0; i < 3; i++)
      seed(edb, { id: `ex-${i}`, tool: "read_note", valid_until: NOW - 1 });
    const { registry, ctx } = harness(edb);
    const out = un<StatsOut>(await registry.dispatch("episode_stats", {}, ctx()));
    expect(out.total).toBe(6);
    expect(out.buckets).toEqual([{ key: "read_note", count: 6 }]);
  });

  it("groups by status as well as tool", async () => {
    const edb = edb0();
    many(edb, "read_note", 6);
    for (let i = 0; i < 5; i++) seed(edb, { id: `er-${i}`, tool: "read_note", status: "error" });
    const { registry, ctx } = harness(edb);
    const out = un<StatsOut>(
      await registry.dispatch("episode_stats", { group_by: "status", min_bucket: 2 }, ctx()),
    );
    expect(out.buckets).toEqual([
      { key: "ok", count: 6 },
      { key: "error", count: 5 },
    ]);
  });
});
