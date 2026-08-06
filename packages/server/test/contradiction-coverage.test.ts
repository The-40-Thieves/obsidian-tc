// THE-646: a vault whose contradiction checks all dead-lettered must not render as a clear vault.
//
// THE-613 stopped the JOB fabricating `no_conflict`. It did not stop the READER implying one: an
// unjudged pair writes no row, synthesis selects `status = 'open'`, and `(none)` is printed whether
// the vault is genuinely clear or every check died. The load-bearing test here is the `(none)` one.
//
// Not hypothetical. Measured on the live store 2026-08-06: 159 contradiction jobs in state
// 'failed', every one with `last_error LIKE '%unjudged%'`, against 7 open contradictions.
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import {
  contradictionCoverage,
  coverageCaveat,
  NO_COVERAGE_LOSS,
} from "../src/plane/contradiction-coverage";
import { buildUserMessage } from "../src/plane/jobs/synthesis";
import { openMemoryDb } from "./helpers";

/** The columns of `jobs` this reader touches (20260723_002_jobs.sql). */
function dbWithJobs(): Database {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, class TEXT NOT NULL," +
      " state TEXT NOT NULL DEFAULT 'queued', payload TEXT, last_error TEXT," +
      " created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  );
  return db;
}

function addJob(db: Database, id: string, type: string, state: string, vaultId: string): void {
  db.prepare(
    "INSERT INTO jobs (id, type, class, state, payload, created_at, updated_at) VALUES (?, ?, 'plane', ?, ?, 0, 0)",
  ).run(id, type, state, JSON.stringify({ vaultId, chunkId: `c-${id}` }));
}

describe("contradictionCoverage", () => {
  it("counts dead-lettered contradiction checks for the vault", () => {
    const db = dbWithJobs();
    addJob(db, "a", "contradiction", "failed", "main");
    addJob(db, "b", "contradiction", "failed", "main");
    expect(contradictionCoverage(db, "main")).toEqual({ deadLettered: 2 });
  });

  it("counts ONLY terminal failures — a retrying job has not finished failing", () => {
    // Counting `retrying` would make the caveat flap between runs for a vault that is fine. The
    // number has to still be true tomorrow to be worth showing a reader.
    const db = dbWithJobs();
    addJob(db, "a", "contradiction", "failed", "main");
    addJob(db, "b", "contradiction", "retrying", "main");
    addJob(db, "c", "contradiction", "queued", "main");
    addJob(db, "d", "contradiction", "running", "main");
    addJob(db, "e", "contradiction", "complete", "main");
    expect(contradictionCoverage(db, "main")).toEqual({ deadLettered: 1 });
  });

  it("does not count another job type's failures", () => {
    // `synthesis` and `audit` also dead-letter. Attributing those to contradiction coverage would
    // warn about a gap that does not exist — and a check that cries wolf gets muted.
    const db = dbWithJobs();
    addJob(db, "a", "synthesis", "failed", "main");
    addJob(db, "b", "audit", "failed", "main");
    expect(contradictionCoverage(db, "main")).toEqual({ deadLettered: 0 });
  });

  it("is scoped per vault", () => {
    const db = dbWithJobs();
    addJob(db, "a", "contradiction", "failed", "main");
    addJob(db, "b", "contradiction", "failed", "other");
    expect(contradictionCoverage(db, "main").deadLettered).toBe(1);
    expect(contradictionCoverage(db, "other").deadLettered).toBe(1);
    expect(contradictionCoverage(db, "absent").deadLettered).toBe(0);
  });

  it("degrades to zero when the job queue table is absent", () => {
    // A missing queue must weaken the caveat, not kill the synthesis pass that carries it.
    expect(contradictionCoverage(openMemoryDb(), "main")).toEqual(NO_COVERAGE_LOSS);
  });
});

describe("coverageCaveat", () => {
  it("says nothing when nothing was lost", () => {
    expect(coverageCaveat({ deadLettered: 0 })).toBe("");
    expect(coverageCaveat(NO_COVERAGE_LOSS)).toBe("");
  });

  it("states what the ABSENCE means, not merely that jobs failed", () => {
    const s = coverageCaveat({ deadLettered: 159 });
    expect(s).toContain("159");
    expect(s).toContain("INCOMPLETE");
    // The load-bearing clause: a reader seeing a short list must not read it as a complete one.
    expect(s).toContain("absence of");
    expect(s.toLowerCase()).toContain("not evidence");
  });

  it("agrees in number", () => {
    expect(coverageCaveat({ deadLettered: 1 })).toContain("1 contradiction check ");
    expect(coverageCaveat({ deadLettered: 2 })).toContain("2 contradiction checks ");
  });
});

describe("buildUserMessage carries the coverage gap", () => {
  const BIG = 100_000;

  it("THE LOAD-BEARING ONE: an empty list plus a coverage gap no longer reads as a clear vault", () => {
    const clear = buildUserMessage([], [], BIG, 0, { deadLettered: 0 });
    const broken = buildUserMessage([], [], BIG, 0, { deadLettered: 159 });
    // Both still render "(none)" — the list genuinely is empty in both cases.
    expect(clear.message).toContain("(none)");
    expect(broken.message).toContain("(none)");
    // ...but they are no longer byte-identical, which is the entire defect.
    expect(broken.message).not.toBe(clear.message);
    expect(broken.message).toContain("COVERAGE GAP");
    expect(clear.message).not.toContain("COVERAGE GAP");
  });

  it("defaults to no caveat, so existing callers are unchanged", () => {
    expect(buildUserMessage([], [], BIG).message).toBe(
      buildUserMessage([], [], BIG, 0, NO_COVERAGE_LOSS).message,
    );
  });

  it("keeps the caveat under a budget too small for any content", () => {
    // Charged as fixed scaffolding, never packed like a chunk. If it were elastic it would be
    // dropped exactly when the message is most crowded — leaving a truncated list looking whole.
    const tight = buildUserMessage([], [], 400, 0, { deadLettered: 159 });
    expect(tight.message).toContain("COVERAGE GAP");
  });
});
