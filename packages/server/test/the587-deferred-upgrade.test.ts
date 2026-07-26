// THE-587: which deferred-BEGIN write paths were actually exposed to SQLITE_BUSY_SNAPSHOT.
//
// The ticket listed nine candidate sites. Reading each BODY rather than grepping for `BEGIN` — the
// ticket's own instruction — narrowed that to ONE. The condition is read-then-write INSIDE the
// transaction, and it is directional: a transaction that WRITES first takes the write lock at that
// point and never performs an upgrade, so it cannot hit SQLITE_BUSY_SNAPSHOT at all.
//
// Not exposed, and why (each verified against the code, not assumed):
//   cluster.ts:168        the SELECT is at :158, BEFORE the BEGIN — no snapshot held by the txn
//   forget.ts:121         UPDATE first, SELECT after
//   forget.ts:292         pure DELETEs, no read
//   note-quality.ts:263   all reads complete before the BEGIN
//   activation.ts:164     all reads complete before the BEGIN
//   log.ts:87             pure INSERT
//   capture-tools.ts:78   enqueueCapture INSERTs then SELECTs back (queue.ts:45 then :59)
//   session-tools.ts:78   insertSession INSERTs then SELECTs back (sessions.ts:48 then :59)
//   migrate.ts:58         idempotence check is pre-transaction; body is exec + INSERT
//
// Exposed: memory-tools.ts's add_observation, because appendObservation READS the entity row
// (entities.ts:135) and then runs an UPDATE on it (:140), both inside the transaction callback.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { busyReason, inTransaction, inWriteTransaction } from "../src/db/txn";
import type { Database } from "../src/db/types";

const dirs: string[] = [];
const conns: Database[] = [];
afterEach(() => {
  for (const c of conns.splice(0)) c.close?.();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Two connections on one file, holding the shape appendObservation has: a row read back, then
 *  updated. Timeout is generous so a plain SQLITE_BUSY would be waited out — only the unrescuable
 *  snapshot failure can surface. */
async function pair(): Promise<[Database, Database]> {
  const dir = mkdtempSync(join(tmpdir(), "the587-"));
  dirs.push(dir);
  const path = join(dir, "cache.db");
  const a = await openNodeSqlite(path);
  const b = await openNodeSqlite(path);
  conns.push(a, b);
  for (const db of [a, b]) db.exec("PRAGMA busy_timeout = 4000");
  a.exec("CREATE TABLE memory_entities (id TEXT PRIMARY KEY, observations TEXT NOT NULL)");
  a.exec("INSERT INTO memory_entities (id, observations) VALUES ('e1', '[]')");
  return [a, b];
}

const readBack = (db: Database): string =>
  (
    db.prepare("SELECT observations FROM memory_entities WHERE id = 'e1'").get() as {
      observations: string;
    }
  ).observations;

const write = (db: Database, v: string): void => {
  db.prepare("UPDATE memory_entities SET observations = ? WHERE id = 'e1'").run(v);
};

describe("THE-587 — the read-then-write exposure add_observation had", () => {
  // The bug, reproduced against the real helper. A concurrent commit landing between our read and
  // our write is exactly what happens when two callers append observations at once.
  it("deferred inTransaction fails UNRESCUABLY when another connection commits mid-transaction", async () => {
    const [a, b] = await pair();
    let caught: unknown;
    const started = performance.now();
    try {
      inTransaction(a, () => {
        readBack(a); // getEntityById — pins a's snapshot
        // Another caller appends and commits. In production this is a second add_observation.
        b.exec("BEGIN IMMEDIATE");
        write(b, '["from-b"]');
        b.exec("COMMIT");
        write(a, '["from-a"]'); // the UPDATE — an upgrade that SQLite refuses
      });
    } catch (e) {
      caught = e;
    }
    const elapsedMs = performance.now() - started;

    expect(caught).toBeDefined();
    expect(busyReason(caught)).toBe("snapshot");
    // The point of the whole ticket: busy_timeout is 4000ms and did NOT apply. SQLite will not
    // retry an upgrade that could deadlock, so no amount of configured patience helps.
    expect(elapsedMs).toBeLessThan(1000);
  });

  // The fix. The write lock is held from BEGIN, so b cannot commit in the middle — it waits, and
  // a's read-then-write completes as one serialized unit.
  it("inWriteTransaction completes the same interleaving", async () => {
    const [a, b] = await pair();
    const out = inWriteTransaction(a, "memory_observation", () => {
      const before = readBack(a);
      // b cannot get in here: a holds the write lock. Attempting it with a short timeout proves so.
      b.exec("PRAGMA busy_timeout = 50");
      let bBlocked = false;
      try {
        b.exec("BEGIN IMMEDIATE");
        b.exec("ROLLBACK");
      } catch (e) {
        bBlocked = busyReason(e) === "busy";
      }
      expect(bBlocked, "b must be locked out while a holds the write lock").toBe(true);
      write(a, '["from-a"]');
      return before;
    });
    expect(out).toBe("[]");
    expect(readBack(a)).toBe('["from-a"]');
  });

  // Directional, and this is why eight of the nine listed sites needed no change. Getting this
  // backwards would have meant converting pure-write transactions for nothing — which is a real
  // cost, since BEGIN IMMEDIATE acquires the lock earlier and holds it longer.
  it("a WRITE-first transaction is not exposed, even with the same interleaving", async () => {
    const [a, b] = await pair();
    expect(() =>
      inTransaction(a, () => {
        write(a, '["a-first"]'); // takes the write lock HERE — no snapshot to upgrade later
        b.exec("PRAGMA busy_timeout = 50");
        try {
          b.exec("BEGIN IMMEDIATE"); // b is already locked out
          b.exec("ROLLBACK");
        } catch {
          /* expected */
        }
        readBack(a); // reading after the write is harmless
      }),
    ).not.toThrow();
    expect(readBack(a)).toBe('["a-first"]');
  });
});
