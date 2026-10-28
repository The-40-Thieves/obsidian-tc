// GH #995 review: the leader's reconcile runner persists its outcome to cache.db for followers. These
// tests drive the REAL createReconcileRunner (plane-wiring.ts) against a provisioned cache.db, so
// deleting its persist hook, its notes-ready hook, or its abort / leader-epoch guard fails here.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { createReconcileRunner } from "../src/runtime/plane-wiring";
import { persistReconcileState, readPersistedReconcileState } from "../src/runtime/reconcile-state";
import type { IndexStats, IndexVaultArgs } from "../src/search/indexer";
import { bumpLeaderEpoch, readLeaderEpoch } from "../src/search/indexing/leader-epoch";
import { openMemoryDb } from "./helpers";

function provisionedDb() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function freshIndexHealth() {
  return {
    reconcile: "pending",
    reconcileAt: null,
    reconcileErrors: [],
    frontmatterFailures: new Map(),
    notesReady: false,
    writeFailures: 0,
    auditWriteFailures: 0,
    indexQueueBackpressures: 0,
    lastChunksUpserted: null,
    inFlight: null,
  };
}

function stats(): IndexStats {
  return {
    notes_seen: 0,
    notes_indexed: 0,
    chunks_upserted: 0,
    chunks_deleted: 0,
    chunks_unchanged: 0,
    edges_inserted: 0,
    edges_deleted: 0,
    secrets_skipped: 0,
    vec_enabled: true,
    fts_enabled: true,
    notes_upserted: 0,
    notes_deleted: 0,
    notes_embed_failed: 0,
    embed_batch_rejections: 0,
    chunks_dedup_reused: 0,
    chunks_dedup_unresolved: 0,
    notes_stale_skipped: 0,
    notes_frontmatter_failed: 0,
    frontmatter_failures: [],
  } as never;
}

function runnerFor(
  db: ReturnType<typeof provisionedDb>,
  indexVaultRecorded: (opts: IndexVaultArgs) => Promise<IndexStats>,
  extra: { leaderEpoch?: () => number } = {},
) {
  return createReconcileRunner({
    vaults: [{ id: "v1", path: "/unused" }],
    db,
    embeddingProvider: {},
    embedConfig: { batchSize: 8, concurrency: 1, maxBatchTokens: 2048 },
    chunkContext: false,
    representation: {},
    densify: {},
    vaultRegistry: { resolve: (id: string) => ({ id, root: "/unused" }) },
    indexReadableFor: () => () => true,
    sqlHooksFor: () => ({}),
    onVecRebuild: () => {},
    makeOnIndexed: () => undefined,
    indexHealth: freshIndexHealth(),
    streamingWalk: false,
    backgroundEmbed: { mode: "immediate", idleMs: 1, maxDeferMs: 1 },
    indexVaultRecorded,
    roles: null,
    jobRunner: {},
    ...extra,
  } as never);
}

describe("createReconcileRunner persists the leader's outcome to cache.db (GH #995 review)", () => {
  it("a completed pass writes reconcile_state and notes_ready through the production hooks", async () => {
    const db = provisionedDb();
    const runner = runnerFor(db, async (o) => {
      o.onNotesPass?.();
      return stats();
    });
    await runner(new AbortController().signal);
    expect(readPersistedReconcileState(db)).toEqual({
      reconcile: "ok",
      reconcileAt: expect.any(Number),
      reconcileErrors: [],
      notesReady: true,
    });
  });

  it("an aborted pass (shutdown or demotion) is not persisted as the leader's outcome", async () => {
    const db = provisionedDb();
    const controller = new AbortController();
    const runner = runnerFor(db, async () => {
      controller.abort();
      return stats();
    });
    await runner(controller.signal);
    expect(readPersistedReconcileState(db)).toBeUndefined();
  });

  it("a pass whose leader epoch was superseded by a successor is not persisted", async () => {
    const db = provisionedDb();
    bumpLeaderEpoch(db, 1);
    const captured = readLeaderEpoch(db);
    bumpLeaderEpoch(db, 2); // a successor promoted after this run's epoch was captured
    const runner = runnerFor(db, async () => stats(), { leaderEpoch: () => captured });
    await runner(new AbortController().signal);
    expect(readPersistedReconcileState(db)).toBeUndefined();
  });

  it("a pass under the current leader epoch persists the row tagged with that epoch", async () => {
    const db = provisionedDb();
    bumpLeaderEpoch(db, 1);
    const runner = runnerFor(db, async () => stats(), { leaderEpoch: () => readLeaderEpoch(db) });
    await runner(new AbortController().signal);
    expect(readPersistedReconcileState(db)?.reconcile).toBe("ok");
    expect(db.prepare("SELECT epoch FROM reconcile_state WHERE id = 1").get()).toEqual({
      epoch: 1,
    });
  });

  it("a stale-epoch pass never overwrites a successor's row (raw SQL pin, not the reader)", async () => {
    // The reader hides a superseded row, so this reads the table directly: deleting the stale
    // guard in persistRunOutcome would let the predecessor's write replace the successor's row.
    const db = provisionedDb();
    bumpLeaderEpoch(db, 1);
    const captured = readLeaderEpoch(db);
    bumpLeaderEpoch(db, 2);
    persistReconcileState(
      db,
      { reconcile: "ok", reconcileAt: 5, reconcileErrors: [] },
      true,
      readLeaderEpoch(db),
    );
    const runner = runnerFor(db, async () => stats(), { leaderEpoch: () => captured });
    await runner(new AbortController().signal);
    expect(
      db.prepare("SELECT state, reconcile_at, epoch FROM reconcile_state WHERE id = 1").get(),
    ).toEqual({
      state: "ok",
      reconcile_at: 5,
      epoch: 2,
    });
  });

  it("a follower reads notes_ready mid-pass under a bumped epoch, before the pass completes", async () => {
    const db = provisionedDb();
    bumpLeaderEpoch(db, 1);
    let notesPassed!: () => void;
    const notesSeen = new Promise<void>((resolve) => {
      notesPassed = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = runnerFor(
      db,
      async (o) => {
        o.onNotesPass?.();
        notesPassed();
        await held; // the walk is still running: indexVaultRecorded has not resolved
        return stats();
      },
      { leaderEpoch: () => readLeaderEpoch(db) },
    );
    const done = runner(new AbortController().signal);
    await notesSeen;
    expect(readPersistedReconcileState(db)).toEqual({
      reconcile: "pending",
      reconcileAt: null,
      reconcileErrors: [],
      notesReady: true,
    });
    release();
    await done;
    expect(readPersistedReconcileState(db)?.reconcile).toBe("ok");
  });
});
