// THE-227 — ACT-R activation recompute. Proves the base-level scoring (recent > old, frequent >
// single, none -> 0.5 cold start) and that recomputeActivation writes cached_activation_score per
// chunk that has retrieval events. Exercised with a hand-built chunk_retrievals log.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import {
  actrActivation,
  makeActivationLookup,
  recomputeActivation,
  registerActivationRecompute,
} from "../src/experiential/activation";
import { Scheduler } from "../src/scheduler/scheduler";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
];
const DAY = 86_400_000;
const NOW = 1000 * DAY; // fixed clock

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

function addRetrieval(db: Database, chunkId: string, at: number, feedback: number | null = null) {
  db.prepare(
    "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, feedback) VALUES (?, ?, ?, ?)",
  ).run(`${chunkId}-${at}`, chunkId, at, feedback);
}

describe("ACT-R activation recompute (THE-227)", () => {
  it("actrActivation: recent > old, frequent > single, none -> 0.5", () => {
    expect(actrActivation([], NOW)).toBe(0.5);
    const recent = actrActivation([{ retrieved_at: NOW - DAY / 2 }], NOW); // 12h ago
    const old = actrActivation([{ retrieved_at: NOW - 100 * DAY }], NOW);
    expect(recent).toBeGreaterThan(0.5); // sub-day access -> above neutral
    expect(old).toBe(0.5); // stale WITHOUT negative evidence floors at neutral (THE-193)
    expect(recent).toBeGreaterThan(old);
    const frequent = actrActivation(
      [
        { retrieved_at: NOW - DAY },
        { retrieved_at: NOW - 2 * DAY },
        { retrieved_at: NOW - 3 * DAY },
      ],
      NOW,
    );
    const single = actrActivation([{ retrieved_at: NOW - DAY }], NOW);
    expect(frequent).toBeGreaterThan(single);
  });

  it("negative feedback lowers activation, positive raises it", () => {
    const base = actrActivation([{ retrieved_at: NOW - DAY / 2 }], NOW);
    const down = actrActivation([{ retrieved_at: NOW - DAY / 2, feedback: -1 }], NOW);
    const up = actrActivation([{ retrieved_at: NOW - DAY / 2, feedback: 1 }], NOW);
    expect(down).toBeLessThan(base);
    expect(up).toBeGreaterThan(base);
  });

  it("THE-193 stale floor: time alone never demotes below neutral; negative evidence may", () => {
    const staleClean = actrActivation([{ retrieved_at: NOW - 200 * DAY }], NOW);
    expect(staleClean).toBe(0.5);
    const staleNegFb = actrActivation([{ retrieved_at: NOW - 200 * DAY, feedback: -1 }], NOW);
    expect(staleNegFb).toBeLessThan(0.5);
    // research escape hatch: the raw ACT-R curve without the floor
    const unfloored = actrActivation([{ retrieved_at: NOW - 200 * DAY }], NOW, {
      staleFloor: false,
    });
    expect(unfloored).toBeLessThan(0.5);
  });

  it("makeActivationLookup: point reads, null for unknown, never throws", () => {
    const db = edb0();
    addRetrieval(db, "hot", NOW - DAY / 2); // 12h ago -> above the B=0 crossover at 1 day
    recomputeActivation(db, NOW);
    const lookup = makeActivationLookup(db);
    expect(lookup("hot")).toBeGreaterThan(0.5);
    expect(lookup("never-seen")).toBeNull();
    db.exec("DROP TABLE vault_object_state");
    expect(lookup("hot")).toBeNull(); // read failure degrades to inert
  });

  it("THE-653: onError distinguishes a read failure from a legitimate miss", () => {
    const db = edb0();
    addRetrieval(db, "hot", NOW - DAY / 2);
    recomputeActivation(db, NOW);
    const errors: unknown[] = [];
    const lookup = makeActivationLookup(db, { onError: (e) => errors.push(e) });

    // A miss (no state row for this chunk) is NOT an error — it is the documented "no state
    // yet" case, and must stay silent so a cold vault doesn't spam onError on every lookup.
    expect(lookup("never-seen")).toBeNull();
    expect(errors).toHaveLength(0);

    // A genuine read failure — the table is gone, not just the row — still degrades to null
    // (the safe-inert contract is unchanged) but is now distinguishable via the callback: a
    // corrupt/full db is no longer indistinguishable from an empty cache.
    db.exec("DROP TABLE vault_object_state");
    expect(lookup("hot")).toBeNull();
    expect(errors).toHaveLength(1);
  });

  // THE-718: this replaces "outcome axis folds multiplicatively with feedback (THE-230)". The
  // outcome axis was retired (20260806_001), so `feedback` is now the ONLY weighting input and the
  // bound narrows from w in [0.25, 4] to [0.5, 2]. Kept as a weighting test rather than deleted:
  // dropping it would leave the surviving axis with no end-to-end coverage at all.
  it("feedback is the only weighting axis, and recompute reads it end-to-end", () => {
    const base = actrActivation([{ retrieved_at: NOW - DAY / 2 }], NOW);
    const badFeedback = actrActivation([{ retrieved_at: NOW - DAY / 2, feedback: -1 }], NOW);
    const goodFeedback = actrActivation([{ retrieved_at: NOW - DAY / 2, feedback: 1 }], NOW);
    expect(badFeedback).toBeLessThan(base);
    expect(goodFeedback).toBeGreaterThan(base);
    // recompute reads the column end-to-end
    const db = edb0();
    addRetrieval(db, "deadend", NOW - DAY, -1);
    addRetrieval(db, "winner", NOW - DAY, 1);
    recomputeActivation(db, NOW);
    const rows = db
      .prepare("SELECT object_id, cached_activation_score FROM vault_object_state")
      .all() as Array<{ object_id: string; cached_activation_score: number }>;
    const byId = new Map(rows.map((r) => [r.object_id, r.cached_activation_score]));
    expect(byId.get("winner") ?? 0).toBeGreaterThan(byId.get("deadend") ?? 0);
  });

  // THE-634: the proactive-advisory sweep inserts a chunk_retrievals row with
  // surface_type = 'advisory' so record_retrieval_feedback has something to stamp a dismissal
  // against — a note the system PUSHED, not one a caller searched for and got back. Correctness
  // risk found while wiring that sweep: this recompute's two `SELECT ... FROM chunk_retrievals`
  // queries were bare, with no surface_type filter, so an advisory-only chunk would gain ACT-R
  // activation as though it had been genuinely retrieved. This proves the fix holds, not just that
  // it was added.
  it("THE-634: an advisory-only row does NOT move activation — pushed is not retrieved", () => {
    const db = edb0();
    // A chunk with ONLY an advisory push and no real retrieval must stay cold (no vault_object_state
    // row at all), exactly like a chunk with zero events.
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, feedback, surface_type) VALUES ('a1', 'pushed-only', ?, NULL, 'advisory')",
    ).run(NOW - DAY / 2);
    const stats = recomputeActivation(db, NOW);
    expect(stats.chunks).toBe(0);
    expect(
      db.prepare("SELECT 1 FROM vault_object_state WHERE object_id = 'pushed-only'").get(),
    ).toBeUndefined();

    // A chunk with a REAL retrieval plus a LATER advisory push must score identically to the same
    // chunk with the advisory row absent — the advisory event contributes nothing to the ACT-R sum.
    addRetrieval(db, "mixed", NOW - DAY);
    const withoutAdvisory = recomputeActivation(db, NOW);
    const scoreWithout = (
      db
        .prepare("SELECT cached_activation_score AS s FROM vault_object_state WHERE object_id = ?")
        .get("mixed") as { s: number }
    ).s;

    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, feedback, surface_type) VALUES ('a2', 'mixed', ?, NULL, 'advisory')",
    ).run(NOW - DAY / 4); // more recent than the real retrieval — would raise activation if counted
    const withAdvisory = recomputeActivation(db, NOW);
    const scoreWith = (
      db
        .prepare("SELECT cached_activation_score AS s FROM vault_object_state WHERE object_id = ?")
        .get("mixed") as { s: number }
    ).s;
    expect(scoreWith).toBe(scoreWithout);
    expect(withAdvisory.chunks).toBe(withoutAdvisory.chunks);
  });

  it("recomputeActivation writes cached_activation_score per retrieved chunk", () => {
    const db = edb0();
    addRetrieval(db, "hot", NOW - DAY);
    addRetrieval(db, "hot", NOW - 2 * DAY);
    addRetrieval(db, "cold", NOW - 200 * DAY);
    const stats = recomputeActivation(db, NOW);
    expect(stats.chunks).toBe(2);
    const rows = db
      .prepare("SELECT object_id, cached_activation_score, frequency FROM vault_object_state")
      .all() as Array<{ object_id: string; cached_activation_score: number; frequency: number }>;
    const byId = new Map(rows.map((r) => [r.object_id, r]));
    expect(byId.get("hot")?.frequency).toBe(2);
    expect(byId.get("cold")?.frequency).toBe(1);
    const hot = byId.get("hot")?.cached_activation_score ?? 0;
    const cold = byId.get("cold")?.cached_activation_score ?? 0;
    expect(hot).toBeGreaterThan(cold);
    expect(byId.has("never")).toBe(false); // no events -> no row -> stays inert
  });

  it("registerActivationRecompute ticks on the interval, recomputes, reports, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const db = edb0();
      addRetrieval(db, "hot", NOW - DAY / 2); // 12h ago -> above the B=0 crossover
      const seen: Array<{ chunks: number }> = [];
      const sched = new Scheduler();
      registerActivationRecompute(sched, {
        edb: db,
        intervalMs: 1000,
        now: () => NOW,
        onRecompute: (s) => seen.push(s),
      });
      sched.start();
      // interval-only: nothing recomputed before the first tick
      expect(db.prepare("SELECT COUNT(*) AS n FROM vault_object_state").get()).toMatchObject({
        n: 0,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(seen).toEqual([{ chunks: 1 }]);
      expect(makeActivationLookup(db)("hot") ?? 0).toBeGreaterThan(0.5); // state now warm
      await vi.advanceTimersByTimeAsync(2000);
      expect(seen).toHaveLength(3); // idempotent re-runs
      await sched.stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(seen).toHaveLength(3); // stopped, no further ticks
    } finally {
      vi.useRealTimers();
    }
  });

  it("registerActivationRecompute routes a recompute failure to onError without escaping", async () => {
    vi.useFakeTimers();
    try {
      const bad = {
        prepare() {
          throw new Error("boom");
        },
        exec() {},
      } as unknown as Database;
      const errs: unknown[] = [];
      const sched = new Scheduler();
      registerActivationRecompute(sched, {
        edb: bad,
        intervalMs: 1000,
        now: () => NOW,
        onError: (e) => errs.push(e),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1100);
      expect(errs).toHaveLength(1);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
