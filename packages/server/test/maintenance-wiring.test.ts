// THE-466 slice 3: the maintenance-sweep wiring extracted from cli.ts. The extraction was justified
// by testability, so these are the assertions that were impossible while the block lived inside
// run_serve — the emit and the event_log write had no construction site anything could reach.
//
// THE-585 is the cautionary case: three gauges were declared, registered a `# TYPE` line, and
// emitted nothing at all for many releases, because the only wiring lived in the boot function.
// "Registered" is not "emitting"; these tests assert the VALUE arrives.
import { describe, expect, it, vi } from "vitest";
import type { SweepCounts } from "../src/db/maintenance";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { MorgianaEmitter } from "../src/morgiana/emitter";
import { configureMaintenance, sweepTotal } from "../src/runtime/maintenance-wiring";
import { Scheduler } from "../src/scheduler/scheduler";
import { openMemoryDb } from "./helpers";

const NOW = 10_000_000_000;

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function fakeMorgiana() {
  const emitted: Array<[string, string, unknown]> = [];
  const m = {
    emit: (vaultId: string, name: string, payload?: unknown) =>
      emitted.push([vaultId, name, payload]),
  } as unknown as MorgianaEmitter;
  return { m, emitted };
}

const baseDeps = (db: Database, morgiana: MorgianaEmitter) => ({
  db,
  maintenance: {
    enabled: true,
    intervalMinutes: 1,
    jobsCompleteRetentionDays: 7,
    jobsFailedRetentionDays: 30,
    episodesRetentionDays: 90,
    retrievalsRetentionDays: 365,
  },
  retention: { eventLogDays: 30, tracesDays: 30 },
  vaults: [] as { id: string; path: string }[],
  defaultTraceFolder: ".obsidian-tc/traces",
  morgiana,
  eventVaultId: "v1",
  now: () => NOW,
});

describe("sweepTotal — every arm joins the total", () => {
  it("sums all arms, so a sweep that pruned only ONE kind never reads as a no-op", () => {
    // The regression this guards: the total was widened by hand when THE-571 added `jobs` and again
    // when THE-610 added `trace_files`. Summing Object.values is what makes that automatic.
    expect(
      sweepTotal({
        idempotency_keys: 0,
        elicit_tokens: 0,
        event_log: 0,
        jobs: 0,
        episodes: 0,
        chunk_retrievals: 0,
        trace_files: 3,
        sessions_closed: 0,
      }),
    ).toBe(3);
    expect(
      sweepTotal({
        idempotency_keys: 1,
        elicit_tokens: 2,
        event_log: 4,
        jobs: 8,
        episodes: 32,
        chunk_retrievals: 64,
        trace_files: 16,
        sessions_closed: 0,
      }),
    ).toBe(127);
  });

  it("counts an arm that does not exist yet — the 'free for a future arm' claim", () => {
    // Stated as a comment in cli.ts for two releases and never checked. A hand-maintained sum would
    // silently drop this key; Object.values does not.
    const withFutureArm = {
      idempotency_keys: 1,
      elicit_tokens: 0,
      event_log: 0,
      jobs: 0,
      episodes: 0,
      chunk_retrievals: 0,
      trace_files: 0,
      sessions_closed: 0,
      some_future_arm: 5,
    } as unknown as SweepCounts;
    expect(sweepTotal(withFutureArm)).toBe(6);
  });

  it("is zero for an all-zero sweep, so a no-op still reads as a no-op", () => {
    expect(
      sweepTotal({
        idempotency_keys: 0,
        elicit_tokens: 0,
        event_log: 0,
        jobs: 0,
        episodes: 0,
        chunk_retrievals: 0,
        trace_files: 0,
        sessions_closed: 0,
      }),
    ).toBe(0);
  });
});

describe("configureMaintenance", () => {
  it("registers nothing when maintenance is disabled, and says so", async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      const { m, emitted } = fakeMorgiana();
      const sched = new Scheduler();
      const registered = configureMaintenance(sched, {
        ...baseDeps(db, m),
        maintenance: { ...baseDeps(db, m).maintenance, enabled: false },
      });
      expect(registered).toBe(false);
      sched.start();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(emitted).toEqual([]);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits tc.maintenance.sweep with the total AND the per-arm breakdown on each tick", async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      // One expired idempotency row, so the sweep has something real to prune and the emitted total
      // is non-zero. A test that only proved "an event fired with count 0" would pass against a
      // sweep that deleted nothing.
      db.prepare(
        "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run("v1", "old", "t", "h", NOW - 100_000, NOW - 90_000, "{}", 2, NOW - 1);
      const { m, emitted } = fakeMorgiana();
      const sched = new Scheduler();
      expect(configureMaintenance(sched, baseDeps(db, m))).toBe(true);
      sched.start();
      await vi.advanceTimersByTimeAsync(61_000);
      await sched.stop();

      const sweeps = emitted.filter(([, name]) => name === "tc.maintenance.sweep");
      expect(sweeps).toHaveLength(1);
      const [vaultId, , payload] = sweeps[0] as [
        string,
        string,
        { count: number; rows_dropped: SweepCounts },
      ];
      expect(vaultId).toBe("v1");
      expect(payload.count).toBe(1);
      expect(payload.rows_dropped.idempotency_keys).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a sweep_run row to event_log carrying the same total", async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      db.prepare(
        "INSERT INTO elicit_tokens (token, vault_id, tool_name, args_hash, proposed_change_json, caller, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run("tok-old", "v1", "t", "h", null, "c", NOW - 400_000, NOW - 1, null);
      const { m } = fakeMorgiana();
      const sched = new Scheduler();
      configureMaintenance(sched, baseDeps(db, m));
      sched.start();
      await vi.advanceTimersByTimeAsync(61_000);
      await sched.stop();

      const row = db
        .prepare("SELECT result_size, status FROM event_log WHERE event_type = 'sweep_run'")
        .get() as { result_size: number; status: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.status).toBe("ok");
      expect(row?.result_size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a sweep failure to stderr without escaping into the scheduler", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      const bad = {
        prepare() {
          throw new Error("boom");
        },
        exec() {},
      } as unknown as Database;
      const { m } = fakeMorgiana();
      const sched = new Scheduler();
      configureMaintenance(sched, baseDeps(bad, m));
      sched.start();
      await vi.advanceTimersByTimeAsync(61_000);
      await sched.stop();
      expect(writes.join("")).toContain("[maintenance] sweep failed: boom");
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
