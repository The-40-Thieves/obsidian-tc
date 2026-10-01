import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { inWriteTransaction } from "../src/db/txn";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { deindexNote, indexNote } from "../src/search/indexer";
import { computeNotePlan } from "../src/search/indexing/note-plan";
import { applyNoteWrites } from "../src/search/indexing/persist-note-plan";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "v1";
const PATH = "note.md";
const provider = fakeEmbeddingProvider({ dimensions: 8 });

async function twoConnections(): Promise<{ dir: string; dbA: Database; dbB: Database }> {
  const dir = makeTempDir("obtc-write-fence-");
  const dbPath = join(dir, "cache.db");
  const dbA = await openDatabase(dbPath);
  provisionCacheDb(dbA);
  const dbB = await openDatabase(dbPath);
  return { dir, dbA, dbB };
}

const openDirs: Array<{ dir: string; dbA: Database; dbB: Database }> = [];

afterEach(() => {
  while (openDirs.length > 0) {
    const pair = openDirs.pop();
    try {
      pair?.dbA.close?.();
    } catch {}
    try {
      pair?.dbB.close?.();
    } catch {}
    try {
      if (pair) rmTemp(pair.dir);
    } catch {}
  }
});

describe("commit-time write fencing across two real connections (GH #995 follow-up)", () => {
  it("(a) rejects an older delayed write that would commit after a newer one (stale overwrite)", async () => {
    const { dir, dbA, dbB } = await twoConnections();
    openDirs.push({ dir, dbA, dbB });

    // Seed: v1 indexed via connection A. note_write_fence starts at generation 1.
    const seed = await indexNote(dbA, provider, VAULT, PATH, "seed content", false, () => 1);
    expect(seed.staleSkipped).toBe(false);

    // Connection A (the OLDER, DELAYED writer): computes its plan now, capturing fenceGeneration=1
    // — the baseline before connection B's fresher commit lands.
    const { plan: staleAPlan } = computeNotePlan(dbA, VAULT, PATH, "STALE_OLD content", 2, false);
    if (staleAPlan === null) throw new Error("expected a plan for changed content");
    expect(staleAPlan.fenceGeneration).toBe(1);

    // Connection B (the NEWER writer): commits FRESH content first, on its OWN connection —
    // fenceGeneration bumps 1 -> 2.
    const fresh = await indexNote(dbB, provider, VAULT, PATH, "FRESH_NEW content", false, () => 3);
    expect(fresh.staleSkipped).toBe(false);

    // Connection A's ALREADY-COMPUTED stale plan now attempts to commit — this is the exact shape
    // indexNote's own write transaction runs, reproduced directly so the plan's stale baseline
    // (captured before B's commit) is what applyNoteWrites re-checks.
    const staleResult = inWriteTransaction(dbA, "index_note", () =>
      applyNoteWrites(
        dbA,
        provider,
        VAULT,
        staleAPlan,
        false,
        false,
        false,
        false,
        false,
        new Map(),
      ),
    );
    expect(staleResult.staleSkipped).toBe(true);
    expect(staleResult.upserted).toBe(0);
    expect(staleResult.deleted).toBe(0);

    // The FRESH content must survive untouched — a stale overwrite would have reverted it.
    const rows = dbB
      .prepare("SELECT content FROM chunks WHERE vault_id = ? AND path = ?")
      .all(VAULT, PATH) as Array<{ content: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.content).toContain("FRESH_NEW");
      expect(r.content).not.toContain("STALE_OLD");
    }
  });

  it("(b) rejects a late upsert that would resurrect content after a deindex (tombstone)", async () => {
    const { dir, dbA, dbB } = await twoConnections();
    openDirs.push({ dir, dbA, dbB });

    // Seed: existing content indexed via connection A. Fence generation 1.
    const seed = await indexNote(dbA, provider, VAULT, PATH, "existing content", false, () => 1);
    expect(seed.staleSkipped).toBe(false);
    const before = dbA
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND path = ?")
      .get(VAULT, PATH) as { n: number };
    expect(before.n).toBeGreaterThan(0);

    // Connection A (an OLDER, in-flight edit): plans against the pre-delete state, generation 1.
    const { plan: staleAPlan } = computeNotePlan(dbA, VAULT, PATH, "EDIT_BEFORE_DELETE", 2, false);
    if (staleAPlan === null) throw new Error("expected a plan for changed content");
    expect(staleAPlan.fenceGeneration).toBe(1);

    // Connection B: the note is deleted for real — deindexNote tombstones the fence (1 -> 2),
    // UNCONDITIONALLY, even though it has rows to delete here.
    deindexNote(dbB, VAULT, PATH, false, false, undefined, () => 3);
    const afterDelete = dbB
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND path = ?")
      .get(VAULT, PATH) as { n: number };
    expect(afterDelete.n).toBe(0);

    // Connection A's stale, already-computed write now attempts to commit — it must be rejected,
    // not resurrect the deleted note.
    const staleResult = inWriteTransaction(dbA, "index_note", () =>
      applyNoteWrites(
        dbA,
        provider,
        VAULT,
        staleAPlan,
        false,
        false,
        false,
        false,
        false,
        new Map(),
      ),
    );
    expect(staleResult.staleSkipped).toBe(true);

    const afterStaleWrite = dbA
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND path = ?")
      .get(VAULT, PATH) as { n: number };
    expect(afterStaleWrite.n).toBe(0);
  });

  it("a normal, non-racing write from either connection still lands (no false-positive rejection)", async () => {
    const { dir, dbA, dbB } = await twoConnections();
    openDirs.push({ dir, dbA, dbB });

    const a = await indexNote(dbA, provider, VAULT, "a.md", "content a", false, () => 1);
    expect(a.staleSkipped).toBe(false);
    expect(a.upserted).toBeGreaterThan(0);

    // A DIFFERENT path, from the OTHER connection — no race, must land normally.
    const b = await indexNote(dbB, provider, VAULT, "b.md", "content b", false, () => 2);
    expect(b.staleSkipped).toBe(false);
    expect(b.upserted).toBeGreaterThan(0);

    // A follow-up edit to the SAME path, sequential (not racing) — must also land normally.
    const aAgain = await indexNote(dbA, provider, VAULT, "a.md", "content a v2", false, () => 3);
    expect(aAgain.staleSkipped).toBe(false);
    expect(aAgain.upserted).toBeGreaterThan(0);
  });
});
