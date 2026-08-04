// audit.kbHealth (THE-722) — the read surface for a producer that had none.
//
// `plane/jobs/audit.ts` has written a kb_health report on every audit pass since it shipped: 301
// rows in production across ~40 hours, one roughly every 8 minutes. Nothing read them. Both
// liveness checks reported the table `live` because it has rows, which is exactly the blind spot
// check:table-readers was added to catch — and the fix for an orphaned producer is to BUILD THE
// READER, not to stop writing. Deleting the writer would have destroyed the only vault-integrity
// signal the system collects.
//
// Two findings are surfaced here, and they need different verdicts:
//   * the report says there ARE issues        -> warning, with the counts
//   * the reports STOPPED                     -> warning, because a clean-but-stale report reads
//                                                identically to a healthy vault otherwise
import { describe, expect, it } from "vitest";
import { type KbHealthProbe, kbHealthCheck } from "../src/doctor/kb-health";

const ctx = { serverVersion: "test" };
const run = (p?: KbHealthProbe) => kbHealthCheck(p ? { probe: () => p } : {}).run(ctx);
const NOW = 1_700_000_000_000;

const probe = (over: Partial<KbHealthProbe>): KbHealthProbe => ({
  totalReports: 301,
  latestAt: NOW - 5 * 60_000,
  now: NOW,
  hasIssues: false,
  summary: "All checks clean.",
  nullEmbeddings: 0,
  duplicateChunkPositions: 0,
  perVault: [],
  ...over,
});

describe("audit.kbHealth", () => {
  it("is ok and says so when not probed", async () => {
    const r = await run();
    expect(r.status).toBe("ok");
    expect(r.details?.kbHealth).toBe("not probed");
  });

  it("is ok when the audit has never run — an absent report is not a vault fault", async () => {
    const r = await run(probe({ totalReports: 0, latestAt: undefined }));
    expect(r.status).toBe("ok");
    expect(r.details?.kbHealth).toBe("never run");
    expect(r.issues).toBeUndefined();
  });

  it("is ok on a fresh clean report, and SURFACES it — the whole point of the ticket", async () => {
    const r = await run(probe({}));
    expect(r.status).toBe("ok");
    // 301 reports existed and no operator could see one. The count and the verdict must both be
    // visible even when everything is fine, or this is just another silent table.
    expect(r.details?.reports).toBe("301");
    expect(r.summary).toContain("clean");
  });

  it("WARNS when the latest report has issues, and names the counts", async () => {
    const r = await run(
      probe({
        hasIssues: true,
        summary: "3 null embeds; 2 duplicate positions",
        nullEmbeddings: 3,
        duplicateChunkPositions: 2,
        perVault: [{ vault_id: "main", null_embeddings: 3, duplicate_chunk_positions: 2 }],
      }),
    );
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("3");
    expect(r.details?.perVault).toEqual(["main: 3 null embed(s), 2 duplicate position(s)"]);
    expect(r.remediation).toBeTruthy();
  });

  // A clean report from 3 days ago is indistinguishable from a healthy vault unless staleness is
  // its own finding. The job writes every ~8 minutes, so hours of silence means it stopped.
  it("WARNS when reports have stopped, even though the last one was clean", async () => {
    const r = await run(probe({ latestAt: NOW - 30 * 60 * 60 * 1000 }));
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/stopped|stale/i);
    // Not reported as a vault-integrity problem — the vault was fine when last measured.
    expect(r.issues?.join(" ")).not.toContain("null embed");
  });

  it("prefers the ISSUE verdict when the report is both stale and dirty", async () => {
    const r = await run(
      probe({ latestAt: NOW - 30 * 60 * 60 * 1000, hasIssues: true, nullEmbeddings: 7 }),
    );
    expect(r.status).toBe("warning");
    const joined = r.issues?.join(" ") ?? "";
    expect(joined).toContain("7");
    expect(joined).toMatch(/stopped|stale/i);
  });

  it("reports the row count so unbounded growth is visible — the table is not pruned", async () => {
    const r = await run(probe({ totalReports: 50_000 }));
    expect(r.details?.reports).toBe("50000");
  });

  it("never returns fail — a vault-integrity finding breaks no request in flight", async () => {
    const r = await run(probe({ hasIssues: true, nullEmbeddings: 99 }));
    expect(r.status).toBe("warning");
    expect(r.status).not.toBe("fail");
  });
});
