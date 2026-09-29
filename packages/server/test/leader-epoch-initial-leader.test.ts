// Fix round (cross-vendor review): a process that acquires the vault lock as its FIRST attempt
// (starts already leader — vault-lock.test.ts's "onPromote never fires for an election that
// started as leader") never runs wireLeaderEpoch's onPromote callback, because
// startVaultLeaderElection's synchronous `promote(initial)` happens INSIDE that function, before
// its returned VaultLeaderElection object even exists for server-runtime.ts to call
// `election.onPromote(...)` on. wireLeaderEpoch used to seed `current = 0` unconditionally and
// only ever update it from a LATER promotion — so a process that starts as leader after any prior
// failover on this cacheDir (index_leader_epoch.epoch already >= 1, persisted in cache.db) reports
// epoch 0 for its entire lifetime while the table already reads N >= 1. index-vault.ts's
// `readLeaderEpoch(args.db) !== args.leaderEpoch` check then treats EVERY reconcile batch this
// process ever runs as stale (0 !== N) and drops it — boot/periodic index repair silently stops
// working, forever, on that process, with no further promotion to correct it.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import {
  bumpLeaderEpoch,
  readLeaderEpoch,
  wireLeaderEpoch,
} from "../src/search/indexing/leader-epoch";
import { openMemoryDb } from "./helpers";

/** A minimal EpochSource double matching vault-lock.ts's VaultLeaderElection shape used by
 *  wireLeaderEpoch: isLeader() true from construction (the started-as-leader case), onPromote
 *  registered but never fired — exactly what "onPromote never fires for an election that started
 *  as leader" (vault-lock.test.ts) documents. */
function startedAsLeaderElection(): { isLeader(): boolean; onPromote(cb: () => void): void } {
  return {
    isLeader: () => true,
    onPromote: () => {
      /* deliberately never called — matches vault-lock.ts's documented behaviour */
    },
  };
}

describe("wireLeaderEpoch seeds the CURRENT epoch when the election already started as leader", () => {
  it("bumps once at wire time when isLeader() is already true and onPromote will never fire", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);

    // A PRIOR process on this same cacheDir already failed over at least once: index_leader_epoch
    // is already at epoch 2 (persisted in cache.db, which survives a process restart).
    bumpLeaderEpoch(db, 1);
    bumpLeaderEpoch(db, 2);
    expect(readLeaderEpoch(db)).toBe(2);

    // A NEW process boots, acquires the (now-free) lock as its very first attempt — started as
    // leader, onPromote never fires. This is indistinguishable, from wireLeaderEpoch's side, from
    // the demotion-then-successor-boots-into-the-free-lock race the table exists to guard, so it
    // must be treated the SAME as a real promotion: bump once, and seed `current` from the result.
    const election = startedAsLeaderElection();
    const currentLeaderEpoch = wireLeaderEpoch(election, db);

    // Without the fix: currentLeaderEpoch() reads 0 forever (seeded once, never updated), while
    // the table already reads 2 — every reconcile batch this process runs would be treated as
    // stale relative to its OWN capture, even though this process genuinely holds the lock.
    expect(currentLeaderEpoch()).toBe(3);
    expect(readLeaderEpoch(db)).toBe(3);
  });

  it("still bumps once (and only once) per real promotion — no regression for the follower path", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);

    let promoteCb: (() => void) | undefined;
    const election = {
      isLeader: () => false,
      onPromote: (cb: () => void) => {
        promoteCb = cb;
      },
    };
    const currentLeaderEpoch = wireLeaderEpoch(election, db);
    expect(currentLeaderEpoch()).toBe(0);

    promoteCb?.();
    expect(currentLeaderEpoch()).toBe(1);
    expect(readLeaderEpoch(db)).toBe(1);
  });
});
