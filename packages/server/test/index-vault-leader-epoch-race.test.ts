// Fix round (cross-vendor review): index-vault.ts's and notes-flush.ts's epoch-stale checks must READ
// index_leader_epoch INSIDE their write transaction, not before calling inWriteTransaction. WAL lets
// a successor's bumpLeaderEpoch (an autocommit write) land between an outside-the-transaction read
// and this call's own `BEGIN IMMEDIATE`, silently widening the race window the epoch fence closes.
//
// A cross-connection race between two adjacent synchronous statements in one process can't be
// reproduced by timing. Instead, `WriteTxnHooks.onLockWait` (db/txn.ts) fires with the transaction's
// LABEL right after its BEGIN IMMEDIATE returns and before its callback runs. The hook promotes a
// successor there, so the promotion lands exactly at the boundary the fix moved the read across:
//   - fixed code reads inside the callback, after the hook -> sees the bump and drops the batch.
//   - pre-fix code read before `inWriteTransaction` -> never sees it and commits the stale batch.
// The successor bumps through the SAME connection: the write lock is already held by this
// transaction, so a second connection's write could not commit until after it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import type { WriteTxnHooks, WriteTxnLabel } from "../src/db/txn";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { bumpLeaderEpoch } from "../src/search/indexing/leader-epoch";
import { buildRepresentationManifest } from "../src/search/representation";
import { readableStoredRow } from "../src/vault/stored-acl-path";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "v1";

/** Runs `onPromote` once, when the first write transaction labelled `label` has taken the write
 *  lock. Hook errors are swallowed by the txn helper, so `onPromote` must not assert: it records
 *  its result and the test asserts afterwards. */
function promoteAt(label: WriteTxnLabel, onPromote: () => void): WriteTxnHooks {
  let fired = false;
  return {
    onLockWait: (seen) => {
      if (fired || seen !== label) return;
      fired = true;
      onPromote();
    },
  };
}

const openDirs: Array<{ dir: string; dbA: { close?: () => void }; dbB: { close?: () => void } }> =
  [];

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

describe("indexVault epoch read happens inside the write transaction (cross-vendor review fix)", () => {
  it("catches a successor's promotion that lands as the index_batch transaction takes the lock", async () => {
    const dir = makeTempDir("obtc-epoch-race-");
    const dbPath = join(dir, "cache.db");
    const dbA = await openDatabase(dbPath);
    provisionCacheDb(dbA);
    const dbB = await openDatabase(dbPath);
    openDirs.push({ dir, dbA, dbB });

    // This reconcile run "started" under its own promotion, epoch 1.
    const startEpoch = bumpLeaderEpoch(dbA, 1);
    expect(startEpoch).toBe(1);

    // The notes pass runs first at epoch 1 and commits legitimately. The successor promotes once
    // the chunk batch ("index_batch") holds the write lock.
    let promotedTo: number | undefined;
    const root = makeVault("obtc-epoch-race-vault-");
    const provider = fakeEmbeddingProvider({ dimensions: 8 });
    const representation = buildRepresentationManifest(provider, {});

    const stats = await indexVault({
      db: dbA,
      provider,
      vaultId: VAULT,
      root,
      isReadable: () => true,
      now: () => 3,
      representation,
      chunkContext: false,
      leaderEpoch: startEpoch,
      sql: promoteAt("index_batch", () => {
        promotedTo = bumpLeaderEpoch(dbA, 2);
      }),
    });

    expect(promotedTo).toBe(2);
    // The fix: the read happens after the lock is taken, inside the transaction, so it observes
    // the successor's bump and drops the whole chunk batch.
    expect(stats.notes_epoch_stale_skipped).toBeGreaterThan(0);
    expect(stats.chunks_upserted).toBe(0);
    const rows = dbB.prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?").get(VAULT) as {
      n: number;
    };
    expect(rows.n).toBe(0);

    rmTemp(root);
  });

  it("drops a notes-row flush whose leader epoch went stale before the notes transaction reads it", async () => {
    // The notes pass (index_notes_flush) owns the notes row and its FTS body: a successor that
    // promotes as that transaction takes the lock must stop this run's notes row from committing.
    const dir = makeTempDir("obtc-notes-epoch-race-");
    const dbPath = join(dir, "cache.db");
    const dbA = await openDatabase(dbPath);
    provisionCacheDb(dbA);
    const dbB = await openDatabase(dbPath);
    openDirs.push({ dir, dbA, dbB });

    const startEpoch = bumpLeaderEpoch(dbA, 1);
    expect(startEpoch).toBe(1);

    let promotedTo: number | undefined;
    const root = makeVault("obtc-notes-epoch-race-vault-");
    const provider = fakeEmbeddingProvider({ dimensions: 8 });
    const representation = buildRepresentationManifest(provider, {});

    const stats = await indexVault({
      db: dbA,
      provider,
      vaultId: VAULT,
      root,
      isReadable: () => true,
      now: () => 3,
      representation,
      chunkContext: false,
      leaderEpoch: startEpoch,
      sql: promoteAt("index_notes_flush", () => {
        promotedTo = bumpLeaderEpoch(dbA, 2);
      }),
    });

    expect(promotedTo).toBe(2);
    expect(stats.notes_epoch_stale_skipped).toBeGreaterThan(0);
    const notes = dbB
      .prepare("SELECT COUNT(*) AS n FROM notes WHERE vault_id = ? AND path = ?")
      .get(VAULT, "note.md") as { n: number };
    expect(notes.n).toBe(0);
    const fts = dbB
      .prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE vault_id = ?")
      .get(VAULT) as {
      n: number;
    };
    expect(fts.n).toBe(0);
    expect(readableStoredRow(dbB, VAULT, () => true)("note.md")).toBe(false);

    rmTemp(root);
  });
});
