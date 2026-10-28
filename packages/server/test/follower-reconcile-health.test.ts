// GH #995 follow-up: only the vault-lock leader runs reconciles, so a FOLLOWER's in-memory
// indexHealth never leaves "pending". The leader persists its outcome to cache.db
// (runtime/reconcile-state.ts) and a follower's server_health / get_index_status read that row
// back, tagging the answer with reconcile_source ("leader" = read from the row, "self" = this
// process produced it).
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { healthToolsWiringFields } from "../src/mcp/facade-auto";
import type { CallerContext } from "../src/mcp/registry";
import { applyReconcileOutcome, type ReconcileHealth } from "../src/runtime/reconcile-outcome";
import { persistReconcileState } from "../src/runtime/reconcile-state";
import { wireHealthTools } from "../src/runtime/tool-wiring";
import { openMemoryDb } from "./helpers";

type Role = "leader" | "follower";

function freshIndexHealth() {
  return {
    reconcile: "pending" as const,
    reconcileAt: null,
    reconcileErrors: [] as Array<{ vault: string; error: string }>,
    writeFailures: 0,
    frontmatterFailures: new Map<string, unknown>(),
    notesReady: false,
    auditWriteFailures: 0,
    indexQueueBackpressures: 0,
    lastChunksUpserted: null,
    inFlight: null,
  };
}

/** Registers the real health + index-status tools for one process; `role` is read live per call. */
function processWith(db: Database, role: { current: Role }, indexHealth = freshIndexHealth()) {
  const tools = new Map<string, { handler: (input: unknown, ctx: CallerContext) => unknown }>();
  wireHealthTools({
    registry: {
      register: (t: { name: string }) => tools.set(t.name, t as never),
      aclFor: () => undefined,
      maxResponseBytes: 1_000_000,
    },
    version: "test",
    vaults: [{ id: "v1" }],
    startedAt: 0,
    hasVec: false,
    fts: { status: () => ({ state: "available" }) },
    indexHealth,
    getIndexCoordinatorStats: () => ({ queued: 0, active: 0 }),
    getJobQueueStats: () => ({
      queued: 0,
      running: 0,
      retrying: 0,
      failed: 0,
      oldestQueuedAgeMs: null,
    }),
    db,
    getLeaderRole: () => role.current,
  } as never);
  const call = (name: string): unknown => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is not registered`);
    return tool.handler({}, ctx);
  };
  const ctx = {
    caller: null,
    authenticated: true,
    grantedScopes: new Set<string>(),
    vaultId: "v1",
    db,
  } as unknown as CallerContext;
  return {
    indexHealth,
    status: () => call("get_index_status") as Record<string, unknown>,
    health: () => (call("server_health") as { index: Record<string, unknown> }).index,
  };
}

/** The leader's side: fold a pass's results into its own health AND persist it, as plane-wiring does. */
function leaderPass(
  db: Database,
  indexHealth: ReturnType<typeof freshIndexHealth>,
  errors: Array<{ vault: string; error: string }>,
): void {
  applyReconcileOutcome(
    errors.length === 0 ? [{ vault: "v1", error: null }] : errors,
    indexHealth as unknown as ReconcileHealth,
    {
      now: () => 1_000,
      write: () => {},
      persist: (h) => persistReconcileState(db, h, indexHealth.notesReady, 0),
    },
  );
}

describe("follower reports the leader's persisted reconcile state (GH #995)", () => {
  it("a follower reports the leader's persisted outcome, not its own pending default", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const leaderHealth = freshIndexHealth();
    leaderHealth.notesReady = true;
    leaderPass(db, leaderHealth, [{ vault: "v1", error: "embed backend timeout" }]);

    const follower = processWith(db, { current: "follower" });
    const status = follower.status();
    expect(status).toMatchObject({
      reconcile: "degraded",
      reconcile_at: 1_000,
      notes_ready: true,
      reconcile_source: "leader",
    });
    expect(follower.health()).toMatchObject({
      reconcile: "degraded",
      reconcile_at: 1_000,
      notes_ready: true,
      reconcile_source: "leader",
      detail: { reconcile_errors: [{ vault: "v1", error: "embed backend timeout" }] },
    });
  });

  it("a leader keeps reporting its own in-memory state, tagged self", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const leader = processWith(db, { current: "leader" });
    leaderPass(db, leader.indexHealth, []);
    expect(leader.status()).toMatchObject({ reconcile: "ok", reconcile_source: "self" });
    expect(leader.health()).toMatchObject({ reconcile: "ok", reconcile_source: "self" });
  });

  it("a promoted follower reports its own state once its own reconcile has run", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    // A previous leader left the shared row degraded.
    persistReconcileState(
      db,
      { reconcile: "degraded", reconcileAt: 5, reconcileErrors: [{ vault: "v1", error: "old" }] },
      true,
      0,
    );
    const role = { current: "follower" as Role };
    const promoted = processWith(db, role);
    expect(promoted.status()).toMatchObject({ reconcile: "degraded", reconcile_source: "leader" });

    role.current = "leader";
    // Before its own reconcile, the promoted process still has only its in-memory defaults.
    expect(promoted.status()).toMatchObject({ reconcile: "pending", reconcile_source: "self" });

    leaderPass(db, promoted.indexHealth, []);
    expect(promoted.status()).toMatchObject({ reconcile: "ok", reconcile_source: "self" });
    expect(readRow(db)).toMatchObject({ reconcile: "ok" });
  });

  it("a degraded -> ok transition on the leader reaches a follower's next read", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const leaderHealth = freshIndexHealth();
    const follower = processWith(db, { current: "follower" });

    leaderPass(db, leaderHealth, [{ vault: "v1", error: "transient" }]);
    expect(follower.status()).toMatchObject({ reconcile: "degraded" });

    leaderPass(db, leaderHealth, []);
    expect(follower.status()).toMatchObject({ reconcile: "ok", reconcile_at: 1_000 });
  });

  it("a fresh cache with no row reports pending, tagged leader on a follower and self on a leader", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    expect(processWith(db, { current: "follower" }).status()).toMatchObject({
      reconcile: "pending",
      reconcile_at: null,
      notes_ready: false,
      reconcile_source: "leader",
    });
    expect(processWith(db, { current: "leader" }).status()).toMatchObject({
      reconcile: "pending",
      reconcile_source: "self",
    });
  });

  it("a follower whose cache.db predates the migration reports pending and does not throw", () => {
    const db = openMemoryDb();
    expect(() => processWith(db, { current: "follower" }).status()).not.toThrow();
    expect(processWith(db, { current: "follower" }).status()).toMatchObject({
      reconcile: "pending",
      reconcile_source: "leader",
    });
  });

  it("an authenticated server_health reads the persisted row once, so its index block and detail agree", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    persistReconcileState(
      db,
      { reconcile: "degraded", reconcileAt: 1, reconcileErrors: [{ vault: "v1", error: "x" }] },
      false,
      0,
    );
    const prepare = db.prepare.bind(db);
    let rowReads = 0;
    db.prepare = (sql: string) => {
      const stmt = prepare(sql);
      if (!sql.includes("reconcile_state")) return stmt;
      return {
        get: (...args: unknown[]) => {
          rowReads += 1;
          return stmt.get(...args);
        },
      };
    };
    const health = processWith(db, { current: "follower" }).health();
    expect(health).toMatchObject({
      reconcile: "degraded",
      detail: { reconcile_errors: [{ vault: "v1", error: "x" }] },
    });
    expect(rowReads).toBe(1);
  });

  it("hands the cache.db handle to the health tools even without a sessions config", () => {
    const db = openMemoryDb();
    const wiring = healthToolsWiringFields(
      { vaults: [{ id: "v1" }], toolFacade: { mode: "auto", profile: "core" } } as never,
      undefined,
      db,
    );
    expect(wiring.db).toBe(db);
  });
});

function readRow(db: Database): Record<string, unknown> | undefined {
  return db.prepare("SELECT state AS reconcile FROM reconcile_state WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
}
