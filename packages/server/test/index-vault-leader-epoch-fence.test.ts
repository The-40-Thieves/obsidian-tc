// GH #995 follow-up (demotion residual): a leader that demotes (lock lost / lock file replaced)
// while an ONNX sub-batch is mid-call can still COMMIT after a successor has already promoted and
// started its own reconcile. note_write_fence alone does not always catch this — a successor's own
// reconcile may not yet (or ever) replan a note whose content the demoted leader's stale batch is
// about to commit unchanged, so it never bumps that note's fence. leader-epoch.ts's
// index_leader_epoch is the whole-batch backstop: index-vault.ts re-checks it inside the SAME
// transaction a batch commits in, using the epoch the reconcile RUN started with.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { bumpLeaderEpoch } from "../src/search/indexing/leader-epoch";
import { buildRepresentationManifest } from "../src/search/representation";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

function makeVault(prefix: string): string {
  const root = makeTempDir(prefix);
  writeFileSync(join(root, "note.md"), "# Note\nSome content.\n");
  return root;
}

describe("indexVault epoch fencing (GH #995 follow-up: demotion residual)", () => {
  it("drops a whole batch when a successor has promoted since this reconcile run started", async () => {
    const root = makeVault("obtc-epoch-stale-");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const provider = fakeEmbeddingProvider({ dimensions: 8 });
    const representation = buildRepresentationManifest(provider, {});

    // This reconcile run "started" under its OWN promotion, epoch 1.
    const startEpoch = bumpLeaderEpoch(db, 1);
    expect(startEpoch).toBe(1);
    // A successor promotes while this run is (conceptually) mid-flight — epoch bumps to 2, BEFORE
    // this run's batch reaches its commit transaction.
    bumpLeaderEpoch(db, 2);

    const stats = await indexVault({
      db,
      provider,
      vaultId: "v1",
      root,
      isReadable: () => true,
      now: () => 3,
      representation,
      chunkContext: false,
      leaderEpoch: startEpoch,
    });

    expect(stats.notes_epoch_stale_skipped).toBeGreaterThan(0);
    expect(stats.chunks_upserted).toBe(0);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?").get("v1") as {
      n: number;
    };
    expect(rows.n).toBe(0);
    rmTemp(root);
  });

  it("commits normally when leaderEpoch matches the current epoch (no false-positive rejection)", async () => {
    const root = makeVault("obtc-epoch-fresh-");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const provider = fakeEmbeddingProvider({ dimensions: 8 });
    const representation = buildRepresentationManifest(provider, {});

    const epoch = bumpLeaderEpoch(db, 1);

    const stats = await indexVault({
      db,
      provider,
      vaultId: "v1",
      root,
      isReadable: () => true,
      now: () => 2,
      representation,
      chunkContext: false,
      leaderEpoch: epoch,
    });

    expect(stats.notes_epoch_stale_skipped).toBe(0);
    expect(stats.chunks_upserted).toBeGreaterThan(0);
    rmTemp(root);
  });

  it("does not gate index_vault at all when leaderEpoch is omitted (tool / index-on-write callers)", async () => {
    const root = makeVault("obtc-epoch-absent-");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const provider = fakeEmbeddingProvider({ dimensions: 8 });
    const representation = buildRepresentationManifest(provider, {});
    // A promotion happens, but this caller never threads leaderEpoch (index_vault tool /
    // index-on-write's own contract) — it must be entirely unaffected.
    bumpLeaderEpoch(db, 1);
    bumpLeaderEpoch(db, 2);

    const stats = await indexVault({
      db,
      provider,
      vaultId: "v1",
      root,
      isReadable: () => true,
      now: () => 3,
      representation,
      chunkContext: false,
    });
    expect(stats.notes_epoch_stale_skipped).toBe(0);
    expect(stats.chunks_upserted).toBeGreaterThan(0);
    rmTemp(root);
  });
});
