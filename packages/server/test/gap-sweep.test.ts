// THE-719 — the scheduled coverage-gap sweep.
//
// `detectGaps` had exactly one caller (the offline `obsidian-tc gaps` CLI), so `gap_reports` held 0
// rows and the THE-611 read tool it exists for had nothing to read. These tests pin the two
// decisions that make an UNATTENDED sweep different from the CLI one: where its queries come from,
// and what it does when there are none.
//
// COVERAGE BOUNDARY, stated so it is not mistaken for coverage it lacks: these tests do NOT drive
// the full embed -> graphSearch -> persistGapReport path, because graphSearch needs a fully
// migrated cache.db and there is no fixture helper for one. What IS pinned here is everything the
// sweep decides for itself — the query source, its ordering, the cap, the empty-log guard, and the
// registered name and interval. The search closure itself is shared verbatim with the CLI
// (makeGapBatchSearch), which is exercised end to end by `obsidian-tc gaps`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { readLatestGapReport } from "../src/experiential/gaps";
import { recentQueries, registerGapSweep } from "../src/runtime/gap-sweep";
import { openMemoryDb } from "./helpers";

const sql = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${p}`, import.meta.url)), "utf8");
const NOW = 1_700_000_000_000;
const V = "vault-one";

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260626_001", sql: sql("20260626_001_experiential_init.sql") },
    { version: "20260711_001", sql: sql("20260711_001_experiential_outcome.sql") },
    { version: "20260724_001", sql: sql("20260724_001_chunk_retrievals_caller.sql") },
    { version: "20260729_001", sql: sql("20260729_001_gap_reports.sql") },
  ]);
  return db;
}

function logQuery(db: Database, id: string, text: string | null, at: number): void {
  // Only the columns the migrations in edb0() actually create — later migrations add more, and
  // naming one of those here would fail as a FIXTURE bug that reads like a code bug.
  db.prepare(
    `INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results, rerank_score)
     VALUES (?, 'c1', ?, 'search', ?, 1, 0.5)`,
  ).run(id, at, text);
}

describe("recentQueries — the scheduled pass's query source", () => {
  it("returns DISTINCT queries newest-first, capped", () => {
    // The design decision this pins: an unattended "where is the vault thin?" pass draws on what was
    // actually asked. A fixed golden set would measure the golden set forever.
    const db = edb0();
    logQuery(db, "a", "oldest", NOW - 300);
    logQuery(db, "b", "middle", NOW - 200);
    logQuery(db, "c", "middle", NOW - 100); // same text, more recent
    logQuery(db, "d", "newest", NOW);
    expect(recentQueries(db, 10)).toEqual(["newest", "middle", "oldest"]);
    expect(recentQueries(db, 2)).toEqual(["newest", "middle"]);
  });

  it("skips null and empty query text rather than sweeping a blank", () => {
    const db = edb0();
    logQuery(db, "a", null, NOW);
    logQuery(db, "b", "", NOW - 1);
    logQuery(db, "c", "real", NOW - 2);
    expect(recentQueries(db, 10)).toEqual(["real"]);
  });

  it("returns nothing on an empty log rather than throwing", () => {
    expect(recentQueries(edb0(), 10)).toEqual([]);
  });
});

describe("registerGapSweep", () => {
  /** Capture the registered task instead of driving a real Scheduler: the behaviour under test is
   *  the task body, and a fake registrar lets it be invoked directly without a tick loop. */
  function capture(): { task: { name: string; intervalMs: number; run: () => unknown } | null } {
    const box: { task: { name: string; intervalMs: number; run: () => unknown } | null } = {
      task: null,
    };
    return box;
  }
  const fakeScheduler = (box: ReturnType<typeof capture>) =>
    ({
      register: (t: { name: string; intervalMs: number; run: () => unknown }) => {
        box.task = t;
      },
    }) as never;

  it("registers under the name job_schedule reports, at the configured interval", () => {
    // entrypoints.liveness (#674) keys on the scheduler's registered name, so a rename silently
    // turns a reported task into an unreported one.
    const box = capture();
    registerGapSweep(fakeScheduler(box), {
      cacheDb: openMemoryDb(),
      experientialDb: edb0(),
      provider: { id: "t", embed: async () => [] } as never,
      vaultIds: [V],
      intervalMs: 604_800_000,
      maxQueries: 10,
      now: () => NOW,
    });
    expect(box.task?.name).toBe("gap-sweep");
    expect(box.task?.intervalMs).toBe(604_800_000);
  });

  it("writes NO report when nothing has been logged — an empty pass is not a clean vault", async () => {
    // The trap this exists for: a gap_reports row claiming 0/0 reads downstream exactly like a
    // sweep that ran and found no gaps. "Not measured" and "measured, nothing found" must stay
    // distinguishable — the same distinction THE-613 drew for unjudged contradictions.
    const edb = edb0();
    const box = capture();
    let embedCalls = 0;
    registerGapSweep(fakeScheduler(box), {
      cacheDb: openMemoryDb(),
      experientialDb: edb,
      provider: {
        id: "test",
        embed: async () => {
          embedCalls++;
          return [];
        },
      } as never,
      vaultIds: [V],
      intervalMs: 1000,
      maxQueries: 50,
      now: () => NOW,
    });
    await box.task?.run();
    // Not merely "no report": no gateway traffic either. An empty log must cost nothing.
    expect(embedCalls).toBe(0);
    expect(readLatestGapReport(edb, V)).toBeNull();
  });
});
