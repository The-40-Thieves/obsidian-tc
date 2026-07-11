// THE-229 — M8 experiential domain. Proves the reader contract at the retrieval boundary:
// work_search returns eligible-only by default (honest-empty pre-evaluator), never surfaces
// tombstoned/expired rows, partitions by caller, enforces the trust floor; work_episodes is
// the inspection surface; work_forget flips the control-1 tombstone; record_retrieval_feedback
// stamps the THE-230 outcome axis onto the latest retrieval event(s).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { createRetrievalLogger } from "../src/experiential/log";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM8Tools } from "../src/tools/m8";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: read("20260711_002_agent_episodes.sql") },
];
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
  session_id?: string | null;
  summary?: string | null;
}

function seed(db: Database, e: Ep) {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, vault_id, session_id, caller, channel, episode_type,
       tool, status, eligibility, trust, blocked, valid_from, valid_until, summary)
     VALUES (?, ?, 'main', ?, ?, 'dispatch', 'tool_call', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.ts ?? NOW,
    e.session_id ?? null,
    e.caller === undefined ? "tester" : e.caller,
    e.tool ?? "read_note",
    e.status ?? "ok",
    e.eligibility ?? "eligible",
    e.trust ?? 0.6,
    e.blocked ?? 0,
    e.ts ?? NOW,
    e.valid_until ?? null,
    e.summary ?? null,
  );
}

// cache.db side stub for the dispatch pipeline's audit write.
function cacheDb0() {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vault_id TEXT, tool_name TEXT, caller TEXT, duration_ms INTEGER, result_size INTEGER, status TEXT NOT NULL, error_code TEXT, args_hash TEXT, event_type TEXT);",
  );
  return db;
}

/** Unwrap the dispatch envelope ({ ok, data, meta }) to the handler payload. */
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
    grantedScopes: new Set(["read:workspace", "write:workspace"]),
    vaultId: "main",
    db: cache,
    ...over,
  });
  return { registry, ctx };
}

describe("M8 experiential tools (THE-229)", () => {
  it("reports unavailable without an open experiential handle", async () => {
    const { registry, ctx } = harness(undefined);
    const res = un<{ available: boolean }>(await registry.dispatch("work_search", {}, ctx()));
    expect(res.available).toBe(false);
  });

  it("work_search: eligible-only default, tombstone/expiry/trust/caller contract", async () => {
    const db = edb0();
    seed(db, { id: "e-eligible", eligibility: "eligible", trust: 0.6 });
    seed(db, { id: "e-pending", eligibility: "pending", trust: 0.6 });
    seed(db, { id: "e-ineligible", eligibility: "ineligible", trust: 0.06 });
    seed(db, { id: "e-blocked", eligibility: "eligible", blocked: 1 });
    seed(db, { id: "e-expired", eligibility: "eligible", valid_until: NOW - 1 });
    seed(db, { id: "e-lowtrust-pending", eligibility: "pending", trust: 0.06 });
    seed(db, { id: "e-other-caller", eligibility: "eligible", caller: "someone-else" });

    const { registry, ctx } = harness(db);
    const asIds = (r: unknown) =>
      un<{ results: Array<{ id: string }> }>(r)
        .results.map((x) => x.id)
        .sort();

    // default: eligible only, own caller, no blocked/expired
    const base = await registry.dispatch("work_search", {}, ctx());
    expect(asIds(base)).toEqual(["e-eligible"]);

    // include_pending surfaces pending but the trust floor still excludes high-risk
    const pending = await registry.dispatch("work_search", { include_pending: true }, ctx());
    expect(asIds(pending)).toEqual(["e-eligible", "e-pending"]);

    // any_caller crosses the partition explicitly
    const cross = await registry.dispatch("work_search", { any_caller: true }, ctx());
    expect(asIds(cross)).toEqual(["e-eligible", "e-other-caller"]);

    // provenance rides every result
    const one = un<{ results: Array<Record<string, unknown>> }>(base).results[0];
    expect(one).toMatchObject({ caller: "tester", channel: "dispatch", eligibility: "eligible" });
    expect(one?.trust).toBe(0.6);
  });

  it("work_episodes inspects pending/ineligible; blocked only with include_blocked", async () => {
    const db = edb0();
    seed(db, { id: "p1", eligibility: "pending" });
    seed(db, { id: "i1", eligibility: "ineligible", trust: 0.06 });
    seed(db, { id: "b1", eligibility: "eligible", blocked: 1 });
    const { registry, ctx } = harness(db);
    const list = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", {}, ctx()),
    );
    expect(list.episodes.map((e) => e.id).sort()).toEqual(["i1", "p1"]);
    const withBlocked = un<{ episodes: Array<{ id: string }> }>(
      await registry.dispatch("work_episodes", { include_blocked: true }, ctx()),
    );
    expect(withBlocked.episodes.map((e) => e.id).sort()).toEqual(["b1", "i1", "p1"]);
  });

  it("work_forget tombstones an episode and work_search stops returning it", async () => {
    const db = edb0();
    seed(db, { id: "gone", eligibility: "eligible" });
    const { registry, ctx } = harness(db);
    const before = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", {}, ctx()),
    );
    expect(before.results.map((r) => r.id)).toEqual(["gone"]);
    const res = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "gone" }, ctx()),
    );
    expect(res.forgotten).toBe(true);
    const after = un<{ results: Array<{ id: string }> }>(
      await registry.dispatch("work_search", {}, ctx()),
    );
    expect(after.results).toEqual([]);
    // idempotent second forget: no change, no error
    const again = un<{ forgotten: boolean }>(
      await registry.dispatch("work_forget", { episode_id: "gone" }, ctx()),
    );
    expect(again.forgotten).toBe(false);
  });

  it("record_retrieval_feedback stamps the latest retrieval event(s) for a chunk", async () => {
    const db = edb0();
    let t = NOW;
    const log = createRetrievalLogger(db, { now: () => t++ });
    log({
      queryText: "q1",
      surfaceType: "search_semantic",
      hits: [{ chunkId: "c1", rank: 1, score: 0.9 }],
    });
    log({
      queryText: "q2",
      surfaceType: "search_semantic",
      hits: [{ chunkId: "c1", rank: 1, score: 0.8 }],
    });
    const { registry, ctx } = harness(db);
    const res = un<{ updated: number }>(
      await registry.dispatch(
        "record_retrieval_feedback",
        { chunk_id: "c1", outcome: 1, feedback: 1 },
        ctx(),
      ),
    );
    expect(res.updated).toBe(1); // last_n defaults to 1 -> newest only
    const rows = db
      .prepare("SELECT query_text, feedback, outcome FROM chunk_retrievals ORDER BY retrieved_at")
      .all() as Array<{ query_text: string; feedback: number | null; outcome: number | null }>;
    expect(rows[0]).toMatchObject({ query_text: "q1", feedback: null, outcome: null });
    expect(rows[1]).toMatchObject({ query_text: "q2", feedback: 1, outcome: 1 });
  });
});
