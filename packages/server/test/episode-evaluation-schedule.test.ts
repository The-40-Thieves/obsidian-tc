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
import type { Database } from "../src/db/types";
import { registerEpisodeEvaluation } from "../src/experiential/reflect";
import { Scheduler } from "../src/scheduler/scheduler";
import { openMemoryDb } from "./helpers";

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
  over: { status?: string; eligibility?: string; args_hash?: string; tool?: string } = {},
): void {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, vault_id, caller, channel, episode_type, tool, status,
       args_hash, eligibility, trust, blocked)
     VALUES (?, ?, 'main', 'agent', 'mcp', 'tool_call', ?, ?, ?, ?, 0.5, 0)`,
  ).run(
    id,
    NOW,
    over.tool ?? "search",
    over.status ?? "ok",
    over.args_hash ?? `h-${id}`,
    over.eligibility ?? "pending",
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
});
