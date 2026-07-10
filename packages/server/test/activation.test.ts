// THE-227 — ACT-R activation recompute. Proves the base-level scoring (recent > old, frequent >
// single, none -> 0.5 cold start) and that recomputeActivation writes cached_activation_score per
// chunk that has retrieval events. Exercised with a hand-built chunk_retrievals log.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { actrActivation, recomputeActivation } from "../src/experiential/activation";
import { openMemoryDb } from "./helpers";

const EXP_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260626_001_experiential_init.sql", import.meta.url)),
  "utf8",
);
const DAY = 86_400_000;
const NOW = 1000 * DAY; // fixed clock

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260626_001", sql: EXP_SQL }]);
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
    expect(old).toBeLessThan(0.5); // stale -> below neutral
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
