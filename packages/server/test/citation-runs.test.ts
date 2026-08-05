// THE-717 item 2 — the citation-pass run log. What is under test is not "does a row get written"
// but "can a reader tell the three NULL states apart", because that is the whole reason the table
// exists and the reason a tool shipped a false caveat without it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import {
  citationRunsCovering,
  closeCitationRun,
  openCitationRun,
} from "../src/experiential/citation-runs";
import { openMemoryDb } from "./helpers";

const T = 1_700_000_000_000;

// The REAL chain, not a hand-copied CREATE TABLE. A transcribed schema lets this suite pass while
// the shipped migration says something else, which is the failure mode a schema test exists to catch.
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));

describe("THE-717: the citation run log separates the three NULL states", () => {
  let db: Database;
  beforeEach(() => {
    db = openMemoryDb();
    runMigrations(db, EXP_CHAIN);
  });

  it("NEVER COVERED reads as no rows — the baseline the other two are distinguished from", () => {
    expect(citationRunsCovering(db, [T, T + 1000])).toHaveLength(0);
  });

  it("a pass that RETURNED is closed; a pass that DIED stays open, and they are distinguishable", () => {
    // This is the pair the whole table exists for. Both stamped nothing. Only one of them finished.
    const died = openCitationRun(db, {
      scope: "window",
      window: [T, T + 1000],
      judgePresent: true,
      startedAt: T,
    });
    const finished = openCitationRun(db, {
      scope: "window",
      window: [T, T + 1000],
      judgePresent: true,
      startedAt: T + 10,
    });
    closeCitationRun(db, finished, {
      scoped: 5,
      stage1Pass: 0,
      judged: 0,
      parseFailures: 0,
      stamped: 0,
      aborted: false,
      finishedAt: T + 20,
    });
    const rows = citationRunsCovering(db, [T + 100, T + 200]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === died)?.finished_at).toBeNull();
    expect(rows.find((r) => r.id === finished)?.finished_at).toBe(T + 20);
    // Both stamped nothing observable in chunk_retrievals. The log is the only thing that separates
    // "died mid-pass" from "completed, had nothing to stamp".
    expect(rows.find((r) => r.id === finished)?.stamped).toBe(0);
  });

  it("an ABORTED pass records that it stamped nothing ON PURPOSE", () => {
    const id = openCitationRun(db, {
      scope: "window",
      window: [T, T + 1000],
      judgePresent: true,
      startedAt: T,
    });
    closeCitationRun(db, id, {
      scoped: 20,
      stage1Pass: 12,
      judged: 12,
      parseFailures: 8,
      stamped: 4,
      aborted: true,
      finishedAt: T + 50,
    });
    const r = citationRunsCovering(db, [T, T + 10])[0];
    expect(r?.aborted).toBe(1);
    expect(r?.parse_failures).toBe(8);
    // It DID stamp the stage-1 negatives before aborting stage 2 — "aborted" is not "did nothing".
    expect(r?.stamped).toBe(4);
  });

  it("a window pass is matched by OVERLAP, not containment", () => {
    // A pass covering 12:00-13:00 genuinely covered a retrieval at 12:30, even though the query
    // window 12:20-12:40 contains neither of the pass's endpoints. Containment would miss it and
    // report "no pass has covered these rows" — the exact false negative being fixed.
    const id = openCitationRun(db, {
      scope: "window",
      window: [T, T + 3_600_000],
      judgePresent: true,
      startedAt: T,
    });
    const hit = citationRunsCovering(db, [T + 1_200_000, T + 2_400_000]);
    expect(hit.map((r) => r.id)).toEqual([id]);
    // ...and a genuinely disjoint window still matches nothing.
    expect(citationRunsCovering(db, [T + 7_200_000, T + 7_300_000])).toHaveLength(0);
  });

  it("a SESSION pass is found by session id, and a null session never matches one", () => {
    openCitationRun(db, {
      scope: "session",
      sessionId: "sess_abc",
      judgePresent: false,
      startedAt: T,
    });
    expect(citationRunsCovering(db, [T + 9e9, T + 9e9 + 1], "sess_abc")).toHaveLength(1);
    // A caller with no session must not inherit a session-scoped pass: `session_id IS NULL` would
    // bind NULL, and SQLite's IS treats that as a value. Same trap as feedback-scope.ts.
    expect(citationRunsCovering(db, [T + 9e9, T + 9e9 + 1], null)).toHaveLength(0);
  });

  it("a MALFORMED session run (scope 'session', session_id NULL) never matches a null-session caller", () => {
    // Inserted with raw SQL because openCitationRun now refuses to write this shape. The read path
    // must still defend against it: `session_id IS ?` bound to NULL would treat NULL as a VALUE and
    // match this row for every caller without a session, reporting a pass that covered nothing.
    // Same SQLite `IS` trap feedback-scope.ts hit on chunk_retrievals.caller.
    db.prepare(
      `INSERT INTO citation_runs (started_at, scope_kind, session_id, judge_present)
       VALUES (?, 'session', NULL, 1)`,
    ).run(T);
    expect(citationRunsCovering(db, [T, T + 10], null)).toHaveLength(0);
    expect(citationRunsCovering(db, [T, T + 10])).toHaveLength(0);
  });

  it("refuses to WRITE a session-scoped run with no session id", () => {
    expect(() =>
      openCitationRun(db, { scope: "session", judgePresent: true, startedAt: T }),
    ).toThrow(/requires a sessionId/);
  });

  it("records judge_present, so a stage-1-only pass is not read as a judged one", () => {
    openCitationRun(db, {
      scope: "window",
      window: [T, T + 10],
      judgePresent: false,
      startedAt: T,
    });
    expect(citationRunsCovering(db, [T, T + 10])[0]?.judge_present).toBe(0);
  });
});
