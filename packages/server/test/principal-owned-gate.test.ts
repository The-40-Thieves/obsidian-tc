// A valid JWT without `sub` authenticates as `caller: null`, and `null` is the absence of an
// identity, not an identity: `IS ?`/`===` cannot tell two absences apart, so every sub-less
// credential used to share one partition. Three paths predated the null-caller closure for tasks and
// advisories and were still open to any valid sub-less token:
//
//   1. work memory   work_episodes / work_search / work_forget bound `caller IS NULL`
//   2. sessions      start_session stored principal NULL; end_session skipped the ownership check
//   3. idempotency   claims and reads keyed only on (vault, key); replay never compared the caller
//
// Each repro below was WATCHED FAILING against the unfixed tree first (output pasted in the PR).
// The fix is two central dispatch gates, not per-handler checks: `principalOwned` tools refuse a
// caller with no identity, and a keyed call refuses one too.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM8Tools } from "../src/tools/m8";
import { openMemoryDb } from "./helpers";
import { makeM5Vault } from "./m5-helpers";

const NOW = 1_700_000_000_000;
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");

function edb(): Database {
  const db = openMemoryDb();
  runMigrations(
    db,
    EXPERIENTIAL_MIGRATION_FILES.map((file) => ({ version: versionOf(file), sql: read(file) })),
  );
  return db;
}

function seed(db: Database, id: string, caller: string | null): void {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, vault_id, session_id, caller, channel, episode_type,
       tool, status, eligibility, trust, blocked, valid_from)
     VALUES (?, ?, 'main', NULL, ?, 'dispatch', 'tool_call', 'read_note', 'ok', 'eligible', 0.6, 0, ?)`,
  ).run(id, NOW, caller, NOW);
}

function workHarness(db: Database) {
  const registry = new ToolRegistry({});
  registerM8Tools(registry, { edb: db, now: () => NOW });
  const cache = openMemoryDb();
  cache.exec(
    "CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vault_id TEXT, tool_name TEXT, caller TEXT, duration_ms INTEGER, result_size INTEGER, status TEXT NOT NULL, error_code TEXT, args_hash TEXT, event_type TEXT);",
  );
  const ctx = (over: Partial<CallerContext>): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:workspace", "write:workspace"]),
    vaultId: "main",
    db: cache,
    ...over,
  });
  return { registry, ctx };
}

describe("1. work memory: sub-less credentials share no partition", () => {
  // Credential A (no sub) recorded `ep-a`; credential B (no sub) is a different caller that the
  // old `caller IS NULL` clause could not tell apart from A.
  const tools: Array<[string, Record<string, unknown>]> = [
    ["work_episodes", {}],
    ["work_episode_chain", { id: "ep-a" }],
    ["work_search", {}],
    ["work_forget", { episode_id: "ep-a" }],
    ["work_result", { result: 1 }],
  ];

  for (const [tool, input] of tools) {
    it(`${tool} refuses a caller with no identity`, async () => {
      const db = edb();
      seed(db, "ep-a", null);
      const { registry, ctx } = workHarness(db);
      const r = await registry.dispatch(tool, input, ctx({ caller: null }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    });
  }

  it("credential B cannot tombstone credential A's episode", async () => {
    const db = edb();
    seed(db, "ep-a", null);
    const { registry, ctx } = workHarness(db);
    await registry.dispatch("work_forget", { episode_id: "ep-a" }, ctx({ caller: null }));
    const row = db.prepare("SELECT blocked FROM agent_episodes WHERE id = 'ep-a'").get() as {
      blocked: number;
    };
    expect(row.blocked).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM forget_log").get()).toEqual({ n: 0 });
  });

  it("an identified caller still sees only its own episodes, never a sub-less one's", async () => {
    const db = edb();
    seed(db, "ep-a", null);
    seed(db, "ep-alice", "alice");
    const { registry, ctx } = workHarness(db);
    const r = await registry.dispatch("work_episodes", {}, ctx({ caller: "alice" }));
    expect(r.ok).toBe(true);
    if (r.ok)
      expect((r.data as { episodes: Array<{ id: string }> }).episodes.map((e) => e.id)).toEqual([
        "ep-alice",
      ]);
  });

  it("the refusal names the remedy (a `sub` claim) so an operator can act on it", async () => {
    const { registry, ctx } = workHarness(edb());
    const r = await registry.dispatch("work_episodes", {}, ctx({ caller: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/sub/);
  });
});

describe("2. sessions: a credential cannot end another credential's session", () => {
  const startAs = (v: ReturnType<typeof makeM5Vault>, caller: string | null) =>
    v.call("start_session", { vault: "test", caller: "declared" }, { caller });

  it("start_session refuses a caller with no identity, so no NULL-principal session is created", async () => {
    const v = makeM5Vault();
    try {
      const r = await startAs(v, null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM workspace_sessions").get()).toEqual({ n: 0 });
    } finally {
      v.cleanup();
    }
  });

  it("a NULL-principal session left by a sub-less credential cannot be closed by credential B", async () => {
    const v = makeM5Vault();
    try {
      // The row a sub-less credential's start_session wrote before this gate existed.
      const a = await startAs(v, "alice");
      if (!a.ok) throw new Error("setup");
      const id = (a.data as { session_id: string }).session_id;
      v.db.prepare("UPDATE workspace_sessions SET principal = NULL WHERE id = ?").run(id);

      for (const caller of [null, "bob"]) {
        const r = await v.call(
          "end_session",
          { vault: "test", session_id: id, end_metadata: { injected: "by-b" } },
          // The helper's default grant is `*`, which includes the cross-principal scope.
          { caller, grantedScopes: new Set(["write:workspace"]) },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("forbidden");
      }
      const row = v.db.prepare("SELECT ended_at FROM workspace_sessions WHERE id = ?").get(id) as {
        ended_at: number | null;
      };
      expect(row.ended_at).toBeNull();

      // admin:workspace is the deliberate way to close an unowned session.
      const admin = await v.call(
        "end_session",
        { vault: "test", session_id: id },
        { caller: "ops", grantedScopes: new Set(["write:workspace", "admin:workspace"]) },
      );
      expect(admin.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});

describe("3. idempotency: the key is namespaced by principal", () => {
  const input = { vault: "test", caller: "declared", idempotency_key: "shared-key-1" };

  it("Bob replaying Alice's key with identical args gets a fresh execution, never Alice's result", async () => {
    const v = makeM5Vault();
    try {
      const alice = await v.call("start_session", input, { caller: "alice" });
      const bob = await v.call("start_session", input, { caller: "bob" });
      expect(alice.ok).toBe(true);
      expect(bob.ok).toBe(true);
      if (!alice.ok || !bob.ok) return;
      const a = alice.data as { session_id: string; trace_path: string };
      const b = bob.data as { session_id: string; trace_path: string };
      expect(b.session_id).not.toBe(a.session_id);
      expect(b.trace_path).not.toBe(a.trace_path);
      const owners = v.db
        .prepare("SELECT id, principal FROM workspace_sessions ORDER BY principal")
        .all();
      expect(owners).toEqual([
        { id: a.session_id, principal: "alice" },
        { id: b.session_id, principal: "bob" },
      ]);
    } finally {
      v.cleanup();
    }
  });

  it("Alice's own retry still replays her result (the namespace did not break idempotency)", async () => {
    const v = makeM5Vault();
    try {
      const first = await v.call("start_session", input, { caller: "alice" });
      const retry = await v.call("start_session", input, { caller: "alice" });
      expect(first.ok && retry.ok).toBe(true);
      if (!first.ok || !retry.ok) return;
      expect((retry.data as { session_id: string }).session_id).toBe(
        (first.data as { session_id: string }).session_id,
      );
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM workspace_sessions").get()).toEqual({ n: 1 });
    } finally {
      v.cleanup();
    }
  });

  it("a keyed call from a caller with no identity is refused, not parked in a shared namespace", async () => {
    // enqueue_capture is not principalOwned, so this exercises the idempotency gate alone: the
    // same call with no key must still run for a sub-less caller.
    const v = makeM5Vault();
    try {
      const keyed = await v.call(
        "enqueue_capture",
        { vault: "test", content: "x", idempotency_key: "k-null" },
        { caller: null },
      );
      expect(keyed.ok).toBe(false);
      if (!keyed.ok) expect(keyed.error.code).toBe("forbidden");
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 0 });
    } finally {
      v.cleanup();
    }
  });

  it("a row recorded for another owner is never readable by an identified caller", async () => {
    const v = makeM5Vault();
    try {
      const first = await v.call("start_session", input, { caller: "alice" });
      if (!first.ok) throw new Error("setup");
      // The migration purges pre-existing rows (none recorded an owner) and the schema refuses an
      // owner-less one (idempotency-legacy-writers.test.ts), so the stand-in is a foreign owner.
      v.db.prepare("UPDATE idempotency_keys SET principal = 'someone-else'").run();
      const again = await v.call("start_session", input, { caller: "alice" });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect((again.data as { session_id: string }).session_id).not.toBe(
        (first.data as { session_id: string }).session_id,
      );
    } finally {
      v.cleanup();
    }
  });
});
