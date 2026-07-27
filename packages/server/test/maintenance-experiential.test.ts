// THE-610 arm 2: the EXPERIENTIAL store's growth curves. These tests are more paranoid than the
// cache.db arms for two reasons.
//
// First, `agent_episodes` is work memory behind the membrane — deleting a LIVE episode destroys
// something no other store holds. So the tests lead with what the sweep REFUSES to touch, the same
// discipline THE-571 applied to terminal-only job pruning.
//
// Second, `chunk_retrievals` is not inert data: `chunk_access_stats` is a VIEW over it, feeding
// activation and note quality. Pruning it REWRITES those numbers, which is a retrieval-behaviour
// change wearing a disk-hygiene costume. The view is asserted directly here so that consequence is
// visible in a test rather than only in a comment.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sweepExperiential } from "../src/db/maintenance";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

// THE-538 idiom: derived from the manifest, not hand-listed, so a new migration cannot break this
// file for a reason that reads as unrelated.
const read = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${file}`, import.meta.url)), "utf8");
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function freshEdb(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

/** Insert an episode. `validUntil` null = live forever; `blocked` = a forget tombstone. */
function insertEpisode(
  db: Database,
  id: string,
  opts: { ts: number; validUntil?: number | null; blocked?: 0 | 1 },
): void {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, vault_id, channel, episode_type, status, eligibility, blocked, valid_until)
     VALUES (?, ?, 'v1', 'dispatch', 'tool_call', 'ok', 'eligible', ?, ?)`,
  ).run(id, opts.ts, opts.blocked ?? 0, opts.validUntil ?? null);
}

const sweep = (db: Database, o?: { episodesDays?: number; retrievalsDays?: number }) =>
  sweepExperiential(db, {
    now: NOW,
    episodesDays: o?.episodesDays ?? 90,
    retrievalsDays: o?.retrievalsDays ?? 365,
  });

describe("sweepExperiential — agent_episodes", () => {
  it("NEVER deletes a live episode, however old", () => {
    // The load-bearing test. A live episode is work memory; age says nothing about whether it is
    // finished with, exactly as for a `retrying` job. Two years old and still live = still kept.
    const db = freshEdb();
    insertEpisode(db, "ancient-live", { ts: NOW - 730 * DAY });
    insertEpisode(db, "recent-live", { ts: NOW - 1 * DAY });
    const n = sweep(db);
    expect(n.episodes).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_episodes").get()).toMatchObject({ n: 2 });
  });

  it("deletes a TOMBSTONED episode past retention, and keeps a recent one", () => {
    // Non-empty floor: the point is watching it actually delete.
    const db = freshEdb();
    insertEpisode(db, "old-tombstone", { ts: NOW - 200 * DAY, blocked: 1 });
    insertEpisode(db, "new-tombstone", { ts: NOW - 2 * DAY, blocked: 1 });
    const n = sweep(db);
    expect(n.episodes).toBe(1);
    expect(db.prepare("SELECT id FROM agent_episodes").all()).toEqual([{ id: "new-tombstone" }]);
  });

  it("deletes an EXPIRED episode past retention", () => {
    const db = freshEdb();
    insertEpisode(db, "expired-old", { ts: NOW - 300 * DAY, validUntil: NOW - 200 * DAY });
    const n = sweep(db);
    expect(n.episodes).toBe(1);
  });

  it("keeps an episode that is expired but still INSIDE the retention window", () => {
    // A tombstone has to outlive its own creation long enough to answer "was this forgotten?".
    const db = freshEdb();
    insertEpisode(db, "expired-recent", { ts: NOW - 40 * DAY, validUntil: NOW - 30 * DAY });
    expect(sweep(db).episodes).toBe(0);
  });

  it("keeps an episode whose valid_until is in the FUTURE — not yet expired", () => {
    // Old capture time, but still valid. Filtering on ts alone would delete this; the row is live.
    const db = freshEdb();
    insertEpisode(db, "long-lived", { ts: NOW - 300 * DAY, validUntil: NOW + 30 * DAY });
    expect(sweep(db).episodes).toBe(0);
  });

  it("ages a tombstone with NO valid_until out on its capture time", () => {
    // COALESCE(valid_until, ts). Without it a blocked row with a NULL valid_until is immortal
    // because the only date column the window could use is missing.
    const db = freshEdb();
    insertEpisode(db, "null-until", { ts: NOW - 200 * DAY, blocked: 1, validUntil: null });
    expect(sweep(db).episodes).toBe(1);
  });
});

describe("sweepExperiential — chunk_retrievals and the view it feeds", () => {
  let seq = 0;
  const insertRetrieval = (db: Database, chunkId: string, at: number) =>
    db
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, cited_in_response) VALUES (?, ?, ?, 1)",
      )
      .run(`r${++seq}`, chunkId, at);

  it("prunes rows past retention and keeps recent ones", () => {
    const db = freshEdb();
    insertRetrieval(db, "c1", NOW - 400 * DAY);
    insertRetrieval(db, "c1", NOW - 10 * DAY);
    const n = sweep(db);
    expect(n.chunk_retrievals).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get()).toMatchObject({ n: 1 });
  });

  it("REWRITES chunk_access_stats — the consequence, asserted rather than only documented", () => {
    // This is why the default is a year rather than the 30-90 days the cache.db arms use. The view
    // is a live aggregate: pruning does not just reclaim disk, it changes access_count and
    // outcome_balance, which feed activation and note quality. A long-tail note genuinely useful
    // two years ago would start looking never-accessed.
    const db = freshEdb();
    insertRetrieval(db, "c1", NOW - 400 * DAY);
    insertRetrieval(db, "c1", NOW - 380 * DAY);
    insertRetrieval(db, "c1", NOW - 10 * DAY);
    const before = db
      .prepare("SELECT access_count FROM chunk_access_stats WHERE chunk_id = 'c1'")
      .get() as { access_count: number };
    expect(before.access_count).toBe(3);

    sweep(db);
    const after = db
      .prepare("SELECT access_count FROM chunk_access_stats WHERE chunk_id = 'c1'")
      .get() as { access_count: number };
    expect(after.access_count).toBe(1); // two of the three accesses are now invisible
  });

  it("a generous retention leaves the derived stats untouched", () => {
    // Pairs with the above: the consequence is a function of the WINDOW, not of sweeping at all.
    const db = freshEdb();
    insertRetrieval(db, "c1", NOW - 400 * DAY);
    insertRetrieval(db, "c1", NOW - 10 * DAY);
    expect(sweep(db, { retrievalsDays: 3650 }).chunk_retrievals).toBe(0);
    expect(
      db.prepare("SELECT access_count FROM chunk_access_stats WHERE chunk_id = 'c1'").get(),
    ).toMatchObject({ access_count: 2 });
  });
});

describe("sweepExperiential — degradation", () => {
  it("is a no-op on a db predating either table, rather than throwing", () => {
    // An experiential.db from before these migrations must still get whatever the rest of the pass
    // can do, instead of the sweep dying here.
    const db = freshEdb();
    db.exec("DROP TABLE agent_episodes");
    db.exec("DROP TABLE chunk_retrievals");
    let out: ReturnType<typeof sweepExperiential> | undefined;
    expect(() => {
      out = sweep(db);
    }).not.toThrow();
    expect(out).toEqual({ episodes: 0, chunk_retrievals: 0 });
  });
});
