// THE-744 — `runCitationIndexPasses` had NO test coverage, which is part of why this went
// unnoticed for as long as it did. `openCitationRun` is called once per transcript-index ENTRY, so
// an invocation over an EMPTY index planned zero passes, opened zero runs, and wrote nothing at
// all. A correctly configured, correctly wired, successfully executed pass therefore left
// `citation_runs` byte-identical to a deployment where the feature had never been enabled — and
// `SELECT * FROM citation_runs` is the documented way to answer "did the pass ever fire?".
//
// The acceptance test the ticket asked for is the first one below: run against an empty index and
// assert the log is NON-EMPTY afterwards. It was watched failing against the pre-fix code.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { runCitationIndexPasses } from "../src/experiential/citation-index";
import { citationRunsCovering } from "../src/experiential/citation-runs";
import { PASS_WINDOW_TOLERANCE_MS } from "../src/experiential/transcript-source";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");

// Minimal by choice, matching citation.test.ts: each entry is a deliberate statement that the code
// under test depends on it.
const EXP_CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260731_001", sql: read("20260731_001_citation_state.sql") },
  { version: "20260805_001", sql: read("20260805_001_citation_runs.sql") },
  { version: "20260806_004", sql: read("20260806_004_citation_runs_judge_errors.sql") },
  // THE-744: the `entries` column this test is about.
  { version: "20260806_005", sql: read("20260806_005_citation_runs_entries.sql") },
];

const T = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

function cacheDb0(): Database {
  const db = openMemoryDb();
  db.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
  return db;
}

/** Write a JSONL index file and return its path. */
function indexFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "otc-cidx-"));
  const p = join(dir, "transcript-index.jsonl");
  writeFileSync(p, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return p;
}

const runs = (db: Database) =>
  db.prepare("SELECT * FROM citation_runs ORDER BY id").all() as Array<{
    scope_kind: string;
    entries: number | null;
    scoped: number | null;
    finished_at: number | null;
    window_from: number | null;
    session_id: string | null;
  }>;

describe("THE-744: an invocation that plans zero passes still records that it ran", () => {
  it("an EMPTY index leaves a row, not an empty table", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    expect(runs(edb)).toHaveLength(0); // the floor: the table starts empty, so a pass is what fills it

    const r = await runCitationIndexPasses(indexFile([]), edb, cacheDb, {});

    expect(r.entries).toBe(0);
    expect(r.passes).toBe(0);
    const rows = runs(edb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope_kind).toBe("index");
    expect(rows[0]?.entries).toBe(0);
    // `finished_at` non-NULL is what separates "ran and had no work" from "started and died" —
    // the distinction the whole log exists to draw.
    expect(rows[0]?.finished_at).not.toBeNull();
  });

  // THIS is what the column buys, and the case is real rather than contrived: two entries 1ms
  // apart collide inside the ambiguity window, so planCitationPasses skips BOTH and the invocation
  // plans zero passes — same zero-pass outcome as an empty index, entirely different operational
  // story. Without `entries` the two rows would be indistinguishable, and the operator would go
  // looking at the producer when the answer is "your entries are ambiguous".
  it("records the ENTRY COUNT, so an empty index is distinguishable from one that was all SKIPPED", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    const lines = [0, 1].map((i) =>
      JSON.stringify({
        vault: "main",
        surface_type: "vault_graph_search",
        query: `q${i}`,
        retrieved_at: T + i, // 1ms apart -> mutual collision -> both skipped
        transcript: "some answer text",
      }),
    );
    const r = await runCitationIndexPasses(indexFile(lines), edb, cacheDb, {});
    expect(r.entries).toBe(2);
    expect(r.passes).toBe(0);
    expect(r.skipped).toHaveLength(2);

    const rows = runs(edb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope_kind).toBe("index");
    // The whole point: 2, not 0. An empty index records 0 here (asserted above), so the two
    // zero-pass invocations are now separable in the durable record.
    expect(rows[0]?.entries).toBe(2);
  });

  it("an invocation that DOES plan passes writes per-pass rows with a NULL entry count", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    // Spaced beyond the collision window so both entries survive the planner.
    const gap = PASS_WINDOW_TOLERANCE_MS * 4;
    const lines = [0, 1].map((i) =>
      JSON.stringify({
        vault: "main",
        surface_type: "vault_graph_search",
        query: `q${i}`,
        retrieved_at: T + i * gap,
        transcript: "some answer text",
      }),
    );
    const r = await runCitationIndexPasses(indexFile(lines), edb, cacheDb, {});
    expect(r.passes).toBe(2);

    const rows = runs(edb);
    // No invocation row — passes were planned, so the per-pass rows already prove it ran.
    expect(rows.every((x) => x.scope_kind !== "index")).toBe(true);
    // ...and `entries` stays NULL on them: a pass does not know how many entries its invocation
    // read, and a 0 would assert that it did know and that the answer was none.
    expect(rows.every((x) => x.entries === null)).toBe(true);
    expect(rows.length).toBeGreaterThan(0); // floor, so the two `every()` calls are not vacuous
  });

  it("the invocation row is NOT returned as coverage of any window or session", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    await runCitationIndexPasses(indexFile([]), edb, cacheDb, {});
    expect(runs(edb)).toHaveLength(1); // it exists...

    // ...but it must never answer "was this retrieval covered?". An invocation that did no work
    // reading as coverage would be a worse lie than the silence this replaced: it would assert a
    // retrieval had been judged when nothing ever looked at it. Scoping it `index` rather than
    // `window` is what makes that structural instead of a filter someone must remember.
    expect(citationRunsCovering(edb, [T - 1000, T + 1000])).toHaveLength(0);
    expect(citationRunsCovering(edb, [T - 1000, T + 1000], "s1")).toHaveLength(0);
  });
});
