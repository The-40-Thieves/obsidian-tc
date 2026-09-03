// THE-698 — the experiential tier was DARK. `evaluateEpisodes` had exactly two non-test call sites:
// its own definition and the manual `obsidian-tc reflect` CLI. Nothing wired it on a schedule the
// way registerActivationRecompute wires activation, so rows born 'pending' stayed pending forever.
// Measured on the live store: 337 of 337 pending, zero eligible, spanning 2026-07-16 to 2026-08-02.
//
// That matters because the read path is eligible-only by contract — work_search returned ZERO rows,
// always, for seventeen days of continuous capture. SECURITY.md meanwhile describes `pending` as
// "a short-lived state and not a quarantine". The capture half worked; the recall half was dark.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  type DeriveClosedWindowsOutcome,
  deriveClosedWindows,
} from "../src/experiential/derive-verdict";
import {
  type DerivedVerdictSummary,
  registerEpisodeEvaluation,
} from "../src/experiential/episode-evaluation-schedule";
import { Scheduler } from "../src/scheduler/scheduler";
import { openMemoryDb } from "./helpers";

// THE-726 fix round 2: `DerivedVerdictSummary` is a hand-maintained structural copy of
// `DeriveClosedWindowsOutcome` (see that type's own comment for why it is declared, not imported,
// in production code). This assertion is the compile-time enforcement that keeps them honest: a
// field added to one and not the other fails HERE, at `bun run typecheck`, instead of drifting
// silently until a caller passes one where the other was expected. Test-only, so importing both
// production types in one file cannot create the import cycle production code avoids.
function _pinDerivedVerdictSummaryMirrorsDeriveClosedWindowsOutcome() {
  const _a: DerivedVerdictSummary = {} as DeriveClosedWindowsOutcome;
  const _b: DeriveClosedWindowsOutcome = {} as DerivedVerdictSummary;
  return { _a, _b };
}

// THE-538 idiom: derived from the manifest, not hand-listed, so a new migration cannot break this
// file for a reason that reads as unrelated. Hand-listing two files here initially failed with
// "no such table: agent_episodes" — the fixture had silently drifted from the production chain.
const read = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${file}`, import.meta.url)), "utf8");
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));
const NOW = 1_000_000_000_000;

function edb(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

function addEpisode(
  db: Database,
  id: string,
  over: {
    status?: string;
    eligibility?: string;
    args_hash?: string;
    tool?: string;
    // THE-726 fix round 3 (G7): needed to seed a row a DERIVED -1 hold rule can act on, without
    // going through deriveClosedWindows itself - undefined -> NULL, same as every pre-existing
    // caller got implicitly before these two fields existed on this fixture.
    task_result?: number | null;
    verdict_source?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, vault_id, caller, channel, episode_type, tool, status,
       args_hash, eligibility, trust, blocked, task_result, verdict_source)
     VALUES (?, ?, 'main', 'agent', 'mcp', 'tool_call', ?, ?, ?, ?, 0.5, 0, ?, ?)`,
  ).run(
    id,
    NOW,
    over.tool ?? "search",
    over.status ?? "ok",
    over.args_hash ?? `h-${id}`,
    over.eligibility ?? "pending",
    over.task_result ?? null,
    over.verdict_source ?? null,
  );
}

const countBy = (db: Database, eligibility: string): number =>
  (
    db
      .prepare("SELECT COUNT(*) AS n FROM agent_episodes WHERE eligibility = ?")
      .get(eligibility) as { n: number }
  ).n;

describe("THE-698 registerEpisodeEvaluation", () => {
  it("promotes pending episodes on the interval, not before the first tick", async () => {
    vi.useFakeTimers();
    try {
      const db = edb();
      for (let i = 0; i < 5; i++) addEpisode(db, `e${i}`);
      const seen: Array<{ promoted: number }> = [];
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, {
        edb: db,
        intervalMs: 1000,
        now: () => NOW,
        onEvaluate: (s) => seen.push(s),
      });
      sched.start();

      // Interval-only, matching activation-recompute: registering must not evaluate.
      expect(countBy(db, "eligible")).toBe(0);

      await vi.advanceTimersByTimeAsync(1000);

      expect(countBy(db, "eligible")).toBe(5);
      expect(seen[0]?.promoted).toBe(5);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never raises a born-ineligible row — the poison scanner's verdict is final", async () => {
    vi.useFakeTimers();
    try {
      const db = edb();
      addEpisode(db, "poison", { eligibility: "ineligible" });
      addEpisode(db, "clean");
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, { edb: db, intervalMs: 1000, now: () => NOW });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);

      // The security boundary. Scheduling this pass must not become a way to launder a row the
      // pre-ingest scanner already refused (THE-238 layer 1).
      expect(countBy(db, "ineligible")).toBe(1);
      expect(countBy(db, "eligible")).toBe(1);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a contradictory caller+tool+args_hash cluster rather than promoting it", async () => {
    vi.useFakeTimers();
    try {
      const db = edb();
      addEpisode(db, "a", { status: "ok", args_hash: "same" });
      addEpisode(db, "b", { status: "error", args_hash: "same" });
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, { edb: db, intervalMs: 1000, now: () => NOW });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);

      // Same inputs yielding both ok and error is not a lesson yet. Both rows stay pending.
      expect(countBy(db, "eligible")).toBe(0);
      expect(countBy(db, "pending")).toBe(2);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a failure to onError without escaping the tick", async () => {
    vi.useFakeTimers();
    try {
      const bad = {
        prepare() {
          throw new Error("boom");
        },
        exec() {},
      } as unknown as Database;
      const errors: unknown[] = [];
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, {
        edb: bad,
        intervalMs: 1000,
        onError: (e) => errors.push(e),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);

      // A scheduled derived-state job that throws must not take the scheduler (or the server) down.
      expect(errors).toHaveLength(1);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // THE-726 review round 1: the derive step is an ADDITION in front of this working pass. A throw
  // in it must not take the pass down or trip the scheduler's own backoff for a tick that would
  // otherwise have succeeded — reachable today (`obsidian-tc reflect` against a cacheDir the server
  // never booted throws "no such table: workspace_sessions" without this guard).
  it("a throwing deriveClosedWindows is routed to onError but does not block evaluateEpisodes", async () => {
    vi.useFakeTimers();
    try {
      const db = edb();
      addEpisode(db, "e1");
      const errors: unknown[] = [];
      const evaluated: Array<{ promoted: number }> = [];
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, {
        edb: db,
        intervalMs: 1000,
        now: () => NOW,
        deriveClosedWindows: async () => {
          throw new Error("derive boom");
        },
        onError: (e) => errors.push(e),
        onEvaluate: (s) => evaluated.push(s),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(errors).toHaveLength(1);
      expect(evaluated[0]?.promoted).toBe(1);
      expect(countBy(db, "eligible")).toBe(1);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful deriveClosedWindows reaches onDerive with its full summary", async () => {
    vi.useFakeTimers();
    try {
      const db = edb();
      const derivedResults: DerivedVerdictSummary[] = [];
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, {
        edb: db,
        intervalMs: 1000,
        now: () => NOW,
        deriveClosedWindows: async () => ({
          sessionsSeen: 3,
          stamped: { minus: 1, zero: 1, plus: 1, drained: 0 },
          skipped: 0,
        }),
        onDerive: (r) => derivedResults.push(r),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(derivedResults).toEqual([
        { sessionsSeen: 3, stamped: { minus: 1, zero: 1, plus: 1, drained: 0 }, skipped: 0 },
      ]);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("with no deriveClosedWindows supplied, evaluateEpisodes still runs unaffected", async () => {
    vi.useFakeTimers();
    try {
      const db = edb();
      addEpisode(db, "e1");
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, { edb: db, intervalMs: 1000, now: () => NOW });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(countBy(db, "eligible")).toBe(1);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // THE-726 fix round 3 (G7): `run`'s call to `evaluateEpisodes` forwards `deps.derivedVerdictHold`
  // - a mutation that dropped that forwarding (hardcoded `false`, or the field simply omitted)
  // would still pass every OTHER test in this file, because none of them seed a `derived` -1 row.
  // This seeds one directly (bypassing deriveClosedWindows itself) and checks it is HELD, which is
  // only possible if the flag actually made it all the way from `deps` into `evaluateEpisodes`.
  it("derivedVerdictHold is forwarded from deps into evaluateEpisodes - a derived -1 is held, not promoted, when the flag is on", async () => {
    vi.useFakeTimers();
    try {
      const db = edb();
      addEpisode(db, "der", { task_result: -1, verdict_source: "derived" });
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, {
        edb: db,
        intervalMs: 1000,
        now: () => NOW,
        derivedVerdictHold: true,
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(countBy(db, "pending")).toBe(1); // held, not promoted -- the flag reached evaluateEpisodes
      expect(countBy(db, "eligible")).toBe(0);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // THE-726 fix round 3 (G7): every OTHER onDerive test here hands `registerEpisodeEvaluation` a
  // hand-built `deriveClosedWindows` mock - none of them prove the REAL function's `stamped` shape
  // (specifically `drained` vs `zero`) actually reaches `onDerive` unmodified. This drives the real
  // `deriveClosedWindows` over a seeded cache.db + experiential.db pair with ONE drained session (a
  // window entirely past its own ended_at) and ONE rules-judged-neutral session, and asserts both
  // counters land where they belong, distinctly.
  it("onDerive, driven by the REAL deriveClosedWindows, reports drained and zero separately", async () => {
    vi.useFakeTimers();
    try {
      const db = edb();
      const cacheDb = openMemoryDb();
      provisionCacheDb(cacheDb);
      const insertSession = (id: string, endedAt: number) =>
        cacheDb
          .prepare(
            "INSERT INTO workspace_sessions (id, vault_id, caller, started_at, ended_at, trace_path) VALUES (?, 'main', 'alice', ?, ?, 'trace.jsonl')",
          )
          .run(id, NOW - 20_000, endedAt);
      const insertEpisode = (id: string, session: string, tool: string, ts: number) =>
        db
          .prepare(
            `INSERT INTO agent_episodes
               (id, ts, vault_id, session_id, caller, channel, episode_type, tool, status, args_hash, task_result, eligibility, blocked, valid_from)
             VALUES (?, ?, 'main', ?, 'alice', 'dispatch', 'tool_call', ?, 'ok', NULL, NULL, 'pending', 0, ?)`,
          )
          .run(id, ts, session, tool, ts);

      const drainedEndedAt = NOW - 5000;
      insertSession("drained", drainedEndedAt);
      insertEpisode("drained-ep", "drained", "read_note", drainedEndedAt + 1000); // postdates ended_at -> drain

      const neutralEndedAt = NOW - 1000;
      insertSession("neutral", neutralEndedAt);
      insertEpisode("neutral-ep", "neutral", "write_note", NOW - 8000); // in bounds, no F/S evidence -> 0

      const derivedResults: DerivedVerdictSummary[] = [];
      const sched = new Scheduler();
      registerEpisodeEvaluation(sched, {
        edb: db,
        intervalMs: 1000,
        now: () => NOW,
        deriveClosedWindows: () => deriveClosedWindows(db, cacheDb, { nowMs: NOW }),
        onDerive: (r) => derivedResults.push(r),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(derivedResults).toHaveLength(1);
      expect(derivedResults[0]?.stamped).toEqual({ minus: 0, zero: 1, plus: 0, drained: 1 });
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
