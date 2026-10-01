// Fix round (cross-vendor review): index-vault.ts's epoch-stale check must READ index_leader_epoch
// INSIDE the "index_batch" write transaction, not before calling inWriteTransaction — WAL lets a
// successor's bumpLeaderEpoch (an autocommit write on its own connection) land between an
// outside-the-transaction read and this call's own `BEGIN IMMEDIATE`, silently widening the race
// window index-vault-leader-epoch-fence.test.ts's demotion/promotion scenario exists to close.
//
// A true OS-level race between two adjacent, non-yielding synchronous statements in the SAME
// process can't be reproduced by timing alone (there is no await between them). Instead this wraps
// the db handed to indexVault so that the SECOND `exec("BEGIN IMMEDIATE")` call — indexVault always
// opens "index_notes_flush" first (flushNotes(), line ~505) and "index_batch" (the chunk apply)
// second, so the second call is always the transaction the epoch check gates — triggers a REAL
// second connection's bumpLeaderEpoch synchronously, before delegating to the real exec. That pins
// the promotion to land exactly at the outside-vs-inside boundary the fix moved the read across:
//   - fixed code reads AFTER `BEGIN IMMEDIATE` returns (inside the callback) -> sees the bump.
//   - pre-fix code read BEFORE `inWriteTransaction` was even called -> never sees it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { bumpLeaderEpoch } from "../src/search/indexing/leader-epoch";
import { buildRepresentationManifest } from "../src/search/representation";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "v1";

/** Wraps a real Database so the Nth `exec("BEGIN IMMEDIATE")` fires `onBeginImmediate`
 *  synchronously before delegating — the write-lock-acquisition instant a second connection's
 *  commit can land at, from indexVault's perspective. `targetOccurrence` is 1-indexed. */
function wrapWithBeginImmediateHook(
  real: Database,
  targetOccurrence: number,
  onBeginImmediate: () => void,
): Database {
  let fired = false;
  let seen = 0;
  return {
    exec(sql: string): void {
      if (!fired && sql.trim().toUpperCase().startsWith("BEGIN IMMEDIATE")) {
        seen += 1;
        if (seen === targetOccurrence) {
          fired = true;
          onBeginImmediate();
        }
      }
      real.exec(sql);
    },
    prepare: (sql: string) => real.prepare(sql),
    prepareCached: real.prepareCached
      ? (sql: string) => real.prepareCached?.(sql) as ReturnType<Database["prepare"]>
      : undefined,
    loadExtension: real.loadExtension ? (path: string) => real.loadExtension?.(path) : undefined,
    close: real.close ? () => real.close?.() : undefined,
    inTransaction: real.inTransaction ? () => real.inTransaction?.() ?? false : undefined,
    readonlyMode: real.readonlyMode,
  };
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

function makeVault(prefix: string): string {
  const root = makeTempDir(prefix);
  writeFileSync(join(root, "note.md"), "# Note\nSome content.\n");
  return root;
}

describe("indexVault epoch read happens inside the index_batch write transaction (cross-vendor review fix)", () => {
  it("catches a successor's promotion that commits exactly at the BEGIN IMMEDIATE boundary", async () => {
    const dir = makeTempDir("obtc-epoch-race-");
    const dbPath = join(dir, "cache.db");
    const dbA = await openDatabase(dbPath);
    provisionCacheDb(dbA);
    const dbB = await openDatabase(dbPath);
    openDirs.push({ dir, dbA, dbB });

    // This reconcile run "started" under its own promotion, epoch 1.
    const startEpoch = bumpLeaderEpoch(dbA, 1);
    expect(startEpoch).toBe(1);

    // The wrapped connection: the instant indexVault's batch commit ("index_batch", the SECOND
    // `BEGIN IMMEDIATE` — the first is "index_notes_flush") calls `BEGIN IMMEDIATE`, a REAL second
    // connection promotes (epoch 1 -> 2) and commits, before the real BEGIN IMMEDIATE is even
    // issued on dbA.
    let successorPromoted = false;
    const raceDb = wrapWithBeginImmediateHook(dbA, 2, () => {
      successorPromoted = true;
      const next = bumpLeaderEpoch(dbB, 2);
      expect(next).toBe(2);
    });

    const root = makeVault("obtc-epoch-race-vault-");
    const provider = fakeEmbeddingProvider({ dimensions: 8 });
    const representation = buildRepresentationManifest(provider, {});

    const stats = await indexVault({
      db: raceDb,
      provider,
      vaultId: VAULT,
      root,
      isReadable: () => true,
      now: () => 3,
      representation,
      chunkContext: false,
      leaderEpoch: startEpoch,
    });

    expect(successorPromoted).toBe(true);
    // The fix: the read happens AFTER `BEGIN IMMEDIATE`, inside the transaction, so it observes
    // the successor's bump landing right at that boundary and drops the whole batch.
    expect(stats.notes_epoch_stale_skipped).toBeGreaterThan(0);
    expect(stats.chunks_upserted).toBe(0);
    const rows = dbB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?").get(VAULT) as {
      n: number;
    };
    expect(rows.n).toBe(0);

    rmTemp(root);
  });
});
