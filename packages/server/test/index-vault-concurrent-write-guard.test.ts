// THE-925: index_vault's batched apply (search/indexing/index-vault.ts -> persist-note-plan.ts)
// pre-reads each note's plan (including its embed() network call) OUTSIDE any transaction, then
// applies a batch of plans inside ONE write transaction. docs/design/search-indexing-and-cache.md's
// safety argument for skipping a freshness re-check at apply time is "indexVault is the sole writer
// on this single connection during the reconcile" — but THE-455 routes write_note/watcher through
// IndexCoordinator -> indexNote on the SAME cache.db connection, so that claim does not hold: an
// indexNote commit can land between indexVault's plan-read and its apply. This reproduces the
// interleaving deterministically (batch size 1, a pausable fake embed provider) and pins the guard
// that must reject a plan computed against state a concurrent writer has since changed.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import {
  deterministicVector,
  type EmbeddingProvider,
  fakeEmbeddingProvider,
} from "../src/embeddings";
import { recordIngestStats } from "../src/metrics/ingest-stats";
import { MetricsRecorder } from "../src/metrics/registry";
import { chunkId, indexNote, indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

/** A deferred promise the test releases by hand, to hold the fake provider's embed() mid-flight
 *  (mirrors test/index-coordinator.test.ts / test/index-vault-in-flight.test.ts). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function pollUntil(predicate: () => boolean, maxIters = 5000): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`pollUntil: condition not met within ${maxIters} microtask ticks`);
}

const VAULT = "v1";
const PATH = "note.md";
const NOW = 1_700_000_000_000;

// Two heading sections -> two stable chunk ids ("1" and "2", positional — see chunk.ts).
const OLD = "## Section A\nAlpha original aaa.\n\n## Section B\nBeta original bbb.\n";
// The on-disk edit indexVault's racy pass plans against: section B dropped entirely, so this
// plan's prune step targets section B's chunk.
const MID = "## Section A\nAlpha CHANGED_MID aaa.\n";
// The concurrent write_note/watcher commit: both sections restored with fresh, distinct content.
const FRESH = "## Section A\nAlpha FRESH_NEW aaa.\n\n## Section B\nBeta FRESH_NEW bbb.\n";

describe("indexVault's batched apply guards against a concurrent index-on-write commit (THE-925)", () => {
  it("does not revert fresh content or prune a fresh chunk when write_note/watcher races the flush", async () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-925-"));
    const filePath = join(root, PATH);
    writeFileSync(filePath, OLD);

    let embedCalls = 0;
    const gate = deferred();
    const provider: EmbeddingProvider = {
      ...fakeEmbeddingProvider({ dimensions: 8 }),
      embed: async (texts: string[]): Promise<number[][]> => {
        embedCalls += 1;
        if (embedCalls === 2) await gate.promise; // pause only indexVault's SECOND (racy) run
        return texts.map((t) => deterministicVector(t, 8));
      },
    };

    const db = openMemoryDb();
    provisionCacheDb(db);
    const representation = buildRepresentationManifest(provider, {});
    const baseArgs = {
      db,
      provider,
      vaultId: VAULT,
      root,
      isReadable: () => true,
      now: () => NOW,
      representation,
      chunkContext: false,
      batch: { maxNotes: 1 }, // one note per flush, so a single-file vault flushes exactly once
    };

    try {
      // Setup pass: index the original two-section note (embedCalls -> 1, never gated).
      await indexVault(baseArgs);

      const idA = chunkId(VAULT, PATH, "1");
      const idB = chunkId(VAULT, PATH, "2");
      const before = db
        .prepare("SELECT id FROM chunks WHERE vault_id = ? AND path = ?")
        .all(VAULT, PATH) as Array<{ id: string }>;
      expect(before).toHaveLength(2);

      // A concurrent editor shrinks the note to ONE section before indexVault's second (racy) walk
      // reads it from disk — this run's plan will prune section B's chunk and re-embed section A's.
      writeFileSync(filePath, MID);
      const runPromise = indexVault(baseArgs);
      await pollUntil(() => embedCalls >= 2);

      // While indexVault's flush is paused inside embed(), the index-on-write path (write_note /
      // the vault watcher, routed through THE-455's IndexCoordinator to indexNote) commits FRESH
      // content for the SAME path, restoring both sections with new text. indexNote's own embed()
      // call is #3 here (never gated), so this `await` only returns once its own write transaction
      // has fully committed.
      await indexNote(db, provider, VAULT, PATH, FRESH, false, () => NOW, undefined, false);

      gate.resolve();
      const stats = await runPromise;

      // The skip is COUNTED, not just logged — see IndexStats.notes_stale_skipped's doc comment.
      expect(stats.notes_stale_skipped).toBe(1);

      const rowA = db.prepare("SELECT content FROM chunks WHERE id = ?").get(idA) as
        | { content: string }
        | undefined;
      const rowB = db.prepare("SELECT content FROM chunks WHERE id = ?").get(idB) as
        | { content: string }
        | undefined;

      // Section B's chunk must survive: a stale plan pruning it would be deleting a row the
      // concurrent writer had just committed fresh content into.
      expect(rowB).toBeDefined();
      expect(rowB?.content).toContain("FRESH_NEW");
      expect(rowB?.content).toContain("Beta");

      // Section A's chunk must carry the FRESH content, not the stale MID content indexVault's
      // plan was computed against (a revert).
      expect(rowA).toBeDefined();
      expect(rowA?.content).toContain("FRESH_NEW");
      expect(rowA?.content).not.toContain("CHANGED_MID");

      // Both chunks must still carry a live, active embedding (a wrongful prune deletes the
      // chunk_embeddings row along with the chunk row).
      const embA = db
        .prepare("SELECT COUNT(*) AS n FROM chunk_embeddings WHERE chunk_id = ? AND is_active = 1")
        .get(idA) as { n: number };
      const embB = db
        .prepare("SELECT COUNT(*) AS n FROM chunk_embeddings WHERE chunk_id = ? AND is_active = 1")
        .get(idB) as { n: number };
      expect(embA.n).toBe(1);
      expect(embB.n).toBe(1);

      // The counter reaches the real Prometheus exposition through the SAME recordIngestStats
      // function cli.ts's run_serve calls in production — not a hand-rolled inc*() call, which
      // would only prove the method works, not that the pipeline is wired to it (THE-585's class
      // of bug: a registered-but-never-fed metric).
      const metrics = new MetricsRecorder();
      recordIngestStats(db, metrics, VAULT, stats);
      const text = await metrics.metrics();
      expect(text).toMatch(
        new RegExp(`obsidian_tc_index_stale_skipped_total\\{vault="${VAULT}"\\} 1`),
      );
    } finally {
      rmTemp(root);
    }
  });
});
