// THE-227 — ACT-R activation recompute. Proves the base-level scoring (recent > old, frequent >
// single, none -> 0.5 cold start) and that recomputeActivation writes cached_activation_score per
// chunk that has retrieval events. Exercised with a hand-built chunk_retrievals log.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import {
  actrActivation,
  makeActivationLookup,
  recomputeActivation,
} from "../src/experiential/activation";
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

function addRetrieval(
  db: Database,
  chunkId: string,
  at: number,
  feedback: number | null = null,
  outcome: number | null = null,
) {
  db.prepare(
    "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, feedback, outcome) VALUES (?, ?, ?, ?, ?)",
  ).run(`${chunkId}-${at}`, chunkId, at, feedback, outcome);
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
    const staleNegOut = actrActivation([{ retrieved_at: NOW - 200 * DAY, outcome: -1 }], NOW);
    expect(staleNegOut).toBeLessThan(0.5);
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

  it("outcome axis folds multiplicatively with feedback (THE-230)", () => {
    const base = actrActivation([{ retrieved_at: NOW - DAY / 2 }], NOW);
    const badOutcome = actrActivation([{ retrieved_at: NOW - DAY / 2, outcome: -1 }], NOW);
    const goodOutcome = actrActivation([{ retrieved_at: NOW - DAY / 2, outcome: 1 }], NOW);
    expect(badOutcome).toBeLessThan(base);
    expect(goodOutcome).toBeGreaterThan(base);
    // relevant-but-dead-end (fb +1, outcome -1) cancels back to base weight
    const canceled = actrActivation(
      [{ retrieved_at: NOW - DAY / 2, feedback: 1, outcome: -1 }],
      NOW,
    );
    expect(canceled).toBeCloseTo(base, 10);
    // recompute reads the column end-to-end
    const db = edb0();
    addRetrieval(db, "deadend", NOW - DAY, 1, -1);
    addRetrieval(db, "winner", NOW - DAY, 1, 1);
    recomputeActivation(db, NOW);
    const rows = db
      .prepare("SELECT object_id, cached_activation_score FROM vault_object_state")
      .all() as Array<{ object_id: string; cached_activation_score: number }>;
    const byId = new Map(rows.map((r) => [r.object_id, r.cached_activation_score]));
    expect(byId.get("winner") ?? 0).toBeGreaterThan(byId.get("deadend") ?? 0);
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
});
