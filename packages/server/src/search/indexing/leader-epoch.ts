// GH #995 follow-up: the demotion residual. See db/migrations/20260928_003_index_leader_epoch.sql
// for the table and why note_write_fence alone does not close this gap. wireLeaderEpoch is the
// runtime/server-runtime.ts call site's whole integration (one line there, by construction);
// search/indexing/index-vault.ts reads readLeaderEpoch back inside a reconcile batch's commit
// transaction.
import { tableExists } from "../../db/introspect";
import { cachedPrepare, type Database } from "../../db/types";

/** The subset of VaultLeaderElection (runtime/vault-lock.ts) wireLeaderEpoch needs — avoids this
 *  module importing vault-lock.ts for a type-only dependency. */
interface EpochSource {
  isLeader(): boolean;
  onPromote(cb: () => void): void;
}

const epochTableCache = new WeakMap<Database, boolean>();

/** @internal exported for the memoization test; production callers use it directly. */
export function hasIndexLeaderEpoch(db: Database): boolean {
  const cached = epochTableCache.get(db);
  if (cached !== undefined) return cached;
  const ok = tableExists(db, "index_leader_epoch");
  epochTableCache.set(db, ok);
  return ok;
}

/** The current epoch (0 when never bumped, or on a pre-migration db). Read inside a reconcile
 *  batch's write transaction to detect a successor's promotion since the run started. */
export function readLeaderEpoch(db: Database): number {
  if (!hasIndexLeaderEpoch(db)) return 0;
  const row = cachedPrepare(db, "SELECT epoch FROM index_leader_epoch WHERE id = 1").get() as
    | { epoch: number }
    | undefined;
  return row?.epoch ?? 0;
}

/** Bump and return the new epoch. Call ONCE per promotion (leaderElection.onPromote), never per
 *  reconcile run — every reconcile started by the SAME promotion shares one epoch value. No-op
 *  (returns 0) on a pre-migration db. */
export function bumpLeaderEpoch(db: Database, now: number): number {
  if (!hasIndexLeaderEpoch(db)) return 0;
  cachedPrepare(
    db,
    "INSERT INTO index_leader_epoch (id, epoch, updated_at) VALUES (1, 1, ?) " +
      "ON CONFLICT(id) DO UPDATE SET epoch = epoch + 1, updated_at = excluded.updated_at",
  ).run(now);
  return readLeaderEpoch(db);
}

/** Wires a leader election's onPromote to bumpLeaderEpoch and returns a getter for the LATEST
 *  bumped value — runtime/server-runtime.ts's whole integration point, so that call site stays one
 *  line instead of growing its own closure state (it is already at the repo's 700-line ceiling).
 *
 * Fix round (cross-vendor review): a process that acquires the lock as its FIRST attempt starts
 * already leader — `startVaultLeaderElection`'s initial `promote()` runs synchronously, before its
 * returned election object exists for this function to register `onPromote` on, so that promotion
 * is unobservable here (see vault-lock.test.ts's "onPromote never fires for an election that
 * started as leader"). Left unhandled, this process would seed `current = 0` and never update it,
 * while `index_leader_epoch` may already read N >= 1 from a PRIOR process's failover on the same
 * cacheDir (the table is persisted in cache.db across restarts) — every reconcile batch this
 * process ever runs would then read as stale against its own stuck-at-0 capture.
 *
 * Safe to bump unconditionally when already leader at wire time: this function is called
 * synchronously right after `startVaultLeaderElection` resolves (server-runtime.ts, no `await` in
 * between), so `election.isLeader()` being true here can only reflect that synchronous initial
 * acquire — any LATER, asynchronous promotion (the follower-retry path) cannot have landed yet,
 * and is still caught by `onPromote` below. No double-bump risk. */
export function wireLeaderEpoch(election: EpochSource, db: Database): () => number {
  let current = election.isLeader() ? bumpLeaderEpoch(db, Date.now()) : 0;
  election.onPromote(() => {
    current = bumpLeaderEpoch(db, Date.now());
  });
  return () => current;
}
