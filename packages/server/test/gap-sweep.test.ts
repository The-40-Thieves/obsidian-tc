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
const V2 = "vault-two";

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

/** THE-804: `chunk_retrievals` has no `vault_id`, so the sweep's query source can only be scoped by
 *  resolving `chunk_id` through the AUTHORED store. That makes a real `chunks` table part of this
 *  fixture rather than an optional extra. The full initial migration is used rather than a
 *  hand-rolled CREATE TABLE so the fixture cannot drift from the column the resolver reads. */
function cdb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: sql("20260519_001_initial.sql") }]);
  return db;
}

/** Register a chunk in the authored store so a retrieval logged against it is attributable. */
function addChunk(cdb: Database, chunkId: string, vaultId: string): void {
  cdb
    .prepare(
      `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
     VALUES (?, ?, ?, '0', '[]', 'x', 'h', 1, 0, 0)`,
    )
    .run(chunkId, vaultId, `${vaultId}/note.md`);
}

function logQuery(db: Database, id: string, text: string | null, at: number, chunkId = "c1"): void {
  // Only the columns the migrations in edb0() actually create — later migrations add more, and
  // naming one of those here would fail as a FIXTURE bug that reads like a code bug.
  db.prepare(
    `INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results, rerank_score)
     VALUES (?, ?, ?, 'search', ?, 1, 0.5)`,
  ).run(id, chunkId, at, text);
}

describe("recentQueries — the scheduled pass's query source", () => {
  /** One vault, one chunk, so the scope filter is satisfied and the ordering rules are what shows. */
  function oneVault(): { edb: Database; cdb: Database } {
    const cdb = cdb0();
    addChunk(cdb, "c1", V);
    return { edb: edb0(), cdb };
  }

  it("returns DISTINCT queries newest-first, capped", () => {
    // The design decision this pins: an unattended "where is the vault thin?" pass draws on what was
    // actually asked. A fixed golden set would measure the golden set forever.
    const { edb, cdb } = oneVault();
    logQuery(edb, "a", "oldest", NOW - 300);
    logQuery(edb, "b", "middle", NOW - 200);
    logQuery(edb, "c", "middle", NOW - 100); // same text, more recent
    logQuery(edb, "d", "newest", NOW);
    expect(recentQueries(edb, cdb, V, 10)).toEqual(["newest", "middle", "oldest"]);
    expect(recentQueries(edb, cdb, V, 2)).toEqual(["newest", "middle"]);
  });

  it("skips null and empty query text rather than sweeping a blank", () => {
    const { edb, cdb } = oneVault();
    logQuery(edb, "a", null, NOW);
    logQuery(edb, "b", "", NOW - 1);
    logQuery(edb, "c", "real", NOW - 2);
    expect(recentQueries(edb, cdb, V, 10)).toEqual(["real"]);
  });

  // THE-634 (adversarial review): the proactive-advisory sweep stamps the GOAL TEXT it scored
  // against into query_text on the chunk_retrievals row it pushes (surface_type = 'advisory'), so
  // that text must never be harvested here as though a caller had actually asked it.
  it("THE-634: excludes surface_type='advisory' rows — a goal is not a logged query", () => {
    const { edb, cdb } = oneVault();
    logQuery(edb, "a", "real query", NOW - 100);
    edb
      .prepare(
        `INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results, rerank_score)
         VALUES ('b', 'c1', ?, 'advisory', 'ship the parser', 1, 0.9)`,
      )
      .run(NOW); // newer than the real query — would win the cap/ordering if counted
    expect(recentQueries(edb, cdb, V, 10)).toEqual(["real query"]);
  });

  it("returns nothing on an empty log rather than throwing", () => {
    expect(recentQueries(edb0(), cdb0(), V, 10)).toEqual([]);
  });

  // THE-804 — the leak this function shipped with.
  //
  // `recentQueries` took no vaultId and was called INSIDE the sweep's `for (vaultId of vaultIds)`
  // loop, so every vault was swept with every OTHER vault's raw query text, and `GapItem.query`
  // persists that text verbatim into one vault's `gap_reports.items`.
  //
  // A single-vault fixture cannot see this — which is why the three tests above passed for the
  // life of the defect. The second vault IS the test.
  it("returns only the queries logged against THIS vault", () => {
    const cdb = cdb0();
    addChunk(cdb, "c-one", V);
    addChunk(cdb, "c-two", V2);
    const edb = edb0();
    logQuery(edb, "a", "vault one secret", NOW - 100, "c-one");
    logQuery(edb, "b", "vault two secret", NOW, "c-two");

    expect(recentQueries(edb, cdb, V, 10)).toEqual(["vault one secret"]);
    expect(recentQueries(edb, cdb, V2, 10)).toEqual(["vault two secret"]);
  });

  it("does not let the cap be spent on another vault's queries", () => {
    // The ordering interaction that makes the leak worse than it first looks: the other vault's
    // queries are NEWER here, so an unscoped reader would fill the entire cap with them and this
    // vault would be swept using none of its own.
    const cdb = cdb0();
    addChunk(cdb, "c-one", V);
    addChunk(cdb, "c-two", V2);
    const edb = edb0();
    logQuery(edb, "a", "mine", NOW - 100, "c-one");
    logQuery(edb, "b", "theirs-1", NOW - 2, "c-two");
    logQuery(edb, "c", "theirs-2", NOW - 1, "c-two");

    expect(recentQueries(edb, cdb, V, 2)).toEqual(["mine"]);
  });

  it("fails CLOSED on a retrieval whose chunk is gone — unattributable is not this vault's", () => {
    // Re-chunking drops old ids (explain_answer sees this on 7 of 81 live chunk_ids). A retrieval
    // that can no longer be attributed to a vault must not be swept into one: including it would
    // reintroduce the leak for exactly the rows whose provenance is unrecoverable.
    const cdb = cdb0();
    addChunk(cdb, "c-one", V);
    const edb = edb0();
    logQuery(edb, "a", "attributable", NOW - 100, "c-one");
    logQuery(edb, "b", "orphaned", NOW, "c-vanished");

    expect(recentQueries(edb, cdb, V, 10)).toEqual(["attributable"]);
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
      cacheDb: cdb0(),
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
      cacheDb: cdb0(),
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
