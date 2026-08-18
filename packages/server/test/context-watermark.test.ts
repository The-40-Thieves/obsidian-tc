// THE-647 item 1: the per-(caller, vault) watermark backing differential vault_context. Borrows
// THE-461's discipline (capture the new watermark BEFORE the diff read, persist it only AFTER the
// response is composed) rather than re-deriving it — see context-watermark.ts's module doc for
// the two invariants this closes: the capture-before-read/advance-after ordering, and the FLOOR
// that catches a row the client's OWN `since` would have skipped (a clock running ahead, or a
// stale cached cutoff).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import {
  advanceContextWatermark,
  readContextWatermark,
  watermarkCallerKey,
} from "../src/tools/m7/knowledge/context-watermark";
import { openMemoryDb } from "./helpers";

const sql = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${f}`, import.meta.url)), "utf8");

function cacheDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260519_001", sql: sql("20260519_001_initial.sql") },
    { version: "20260818_001", sql: sql("20260818_001_vault_context_watermark.sql") },
  ]);
  return db;
}

function insertChunk(db: Database, id: string, vaultId: string, updatedAt: number): void {
  db.prepare(
    `INSERT INTO chunks
       (id, vault_id, path, chunk_index, headings, content, content_hash, token_count,
        created_at, updated_at)
     VALUES (?, ?, 'note.md', '0', '', 'x', 'hash', 1, ?, ?)`,
  ).run(id, vaultId, updatedAt, updatedAt);
}

/** Mirrors vault-context.ts's floor computation: `since` is a lower-bound HINT, floored against
 *  the stored watermark when one exists; absent a stored row, `since` is used as-is. */
function floor(clientSinceMs: number, storedMs: number | undefined): number {
  return storedMs !== undefined ? Math.min(clientSinceMs, storedMs) : clientSinceMs;
}

describe("THE-647 item 1 — context-watermark", () => {
  it("a caller with no prior watermark reads undefined — distinct from a stored 0", () => {
    const db = cacheDb();
    expect(readContextWatermark(db, "agent-1", "v1")).toBeUndefined();
  });

  it("advance persists the watermark for exactly that (caller, vault) pair", () => {
    const db = cacheDb();
    advanceContextWatermark(db, "agent-1", "v1", 5000);
    expect(readContextWatermark(db, "agent-1", "v1")).toBe(5000);
    // A different caller, and a different vault for the SAME caller, are untouched.
    expect(readContextWatermark(db, "agent-2", "v1")).toBeUndefined();
    expect(readContextWatermark(db, "agent-1", "v2")).toBeUndefined();
  });

  it("advance never regresses an existing watermark", () => {
    const db = cacheDb();
    advanceContextWatermark(db, "agent-1", "v1", 9000);
    advanceContextWatermark(db, "agent-1", "v1", 4000); // stale/out-of-order — must not win
    expect(readContextWatermark(db, "agent-1", "v1")).toBe(9000);
  });

  it("null caller and empty-string caller share one watermark row (the NULL-safe coercion)", () => {
    const db = cacheDb();
    advanceContextWatermark(db, null, "v1", 3000);
    expect(readContextWatermark(db, "", "v1")).toBe(3000);
    expect(watermarkCallerKey(null)).toBe("");
  });

  // THE-647 item 1 acceptance criterion 3, and the exact subtlety the ticket names: naively
  // advancing the watermark to a value re-read AFTER the diff query ran (rather than one CAPTURED
  // before it started) would silently drop a row written in the window between the two — the row
  // ends up stamped "already seen" without ever having been returned to any caller.
  it("a concurrent write between capture and advance is not skipped by the next diff call", () => {
    const db = cacheDb();
    const caller = "agent-1";
    const vaultId = "v1";

    // Call #1 starts: capture the watermark to (eventually) persist BEFORE running its diff read.
    const capturedAt = 1000;
    const oldWatermark = readContextWatermark(db, caller, vaultId) ?? 0; // no row yet — first call

    // A write lands concurrently with call #1's processing window — AFTER the watermark was
    // captured, but this is exactly the row a naive "re-read MAX after the query" implementation
    // would wrongly claim as already consumed.
    insertChunk(db, "c1", vaultId, 1500);

    // Call #1's diff read runs against the OLD watermark (0) and DOES see the concurrent row,
    // since 1500 > 0 — this call is not the one under test, just establishing realistic ordering.
    const rowsCall1 = db
      .prepare("SELECT id FROM chunks WHERE vault_id = ? AND updated_at > ?")
      .all(vaultId, oldWatermark) as Array<{ id: string }>;
    expect(rowsCall1.map((r) => r.id)).toContain("c1");

    // Call #1 completes and advances the watermark to the CAPTURED value (1000), not to a value
    // re-derived after the concurrent write landed (which would be >= 1500 and would skip c1).
    advanceContextWatermark(db, caller, vaultId, capturedAt);

    // The NEXT diff call reads the persisted watermark and must still see the concurrent write,
    // because 1500 > 1000.
    const nextSince = readContextWatermark(db, caller, vaultId);
    expect(nextSince).toBe(1000);
    const rowsCall2 = db
      .prepare("SELECT id FROM chunks WHERE vault_id = ? AND updated_at > ?")
      .all(vaultId, nextSince ?? 0) as Array<{ id: string }>;
    expect(rowsCall2.map((r) => r.id)).toContain("c1"); // NOT skipped
  });

  it("regression: advancing to a value captured AFTER the concurrent write WOULD have skipped it", () => {
    // Documents the failure mode the previous test guards against, so a future refactor that
    // reintroduces it fails loudly rather than just losing coverage.
    const db = cacheDb();
    const caller = "agent-1";
    const vaultId = "v1";
    insertChunk(db, "c1", vaultId, 1500);

    // The WRONG pattern: capture "now" AFTER the concurrent write is already visible.
    const capturedAfterWrite = 1600;
    advanceContextWatermark(db, caller, vaultId, capturedAfterWrite);

    const nextSince = readContextWatermark(db, caller, vaultId) ?? 0;
    const rows = db
      .prepare("SELECT id FROM chunks WHERE vault_id = ? AND updated_at > ?")
      .all(vaultId, nextSince) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).not.toContain("c1"); // silently dropped — the bug this ticket closes
  });

  // The fix this file exists to cover: `since` alone is not the filter of record. A client-supplied
  // cutoff is floored against the STORED watermark, so a client whose own clock ran ahead of the
  // server's (or replayed a stale `since`) cannot cause a row to be silently and permanently lost.
  describe("the floor — since is a lower-bound HINT, not the filter of record", () => {
    it("the floor catches a row the client's own since would have skipped (client clock ahead)", () => {
      const db = cacheDb();
      const caller = "agent-1";
      const vaultId = "v1";

      // A prior diff call captured its watermark at T=1000 (before its own read ran) and advanced
      // the stored row to exactly that.
      advanceContextWatermark(db, caller, vaultId, 1000);

      // A row lands AFTER that capture, at T=1005 — concurrent with (or shortly after) the prior
      // call, same as the capture-before-read/advance-after tests above.
      insertChunk(db, "late", vaultId, 1005);

      // The client's clock is ahead: it sends since=1010, which is PAST the row's timestamp
      // (1005). A naive `WHERE updated_at > clientSince` would skip "late" forever — there is no
      // future call whose since would ever be smaller again once the client is drifted ahead.
      const clientSinceMs = 1010;
      const stored = readContextWatermark(db, caller, vaultId);
      expect(stored).toBe(1000);
      const effectiveSinceMs = floor(clientSinceMs, stored);
      expect(effectiveSinceMs).toBe(1000); // floored DOWN to the stored watermark, not the client's later value

      const rows = db
        .prepare("SELECT id FROM chunks WHERE vault_id = ? AND updated_at > ?")
        .all(vaultId, effectiveSinceMs) as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toContain("late"); // caught by the floor, not skipped
    });

    it("with no stored watermark, effective since is exactly the client's since — no floor to apply", () => {
      const db = cacheDb();
      const caller = "brand-new-caller";
      const vaultId = "v1";

      expect(readContextWatermark(db, caller, vaultId)).toBeUndefined();

      const clientSinceMs = 500;
      const stored = readContextWatermark(db, caller, vaultId);
      const effectiveSinceMs = floor(clientSinceMs, stored);
      expect(effectiveSinceMs).toBe(clientSinceMs); // unchanged — nothing to floor against
    });

    it("a client since OLDER than the stored watermark is used as-is (the floor only pulls DOWN)", () => {
      const db = cacheDb();
      const caller = "agent-1";
      const vaultId = "v1";
      advanceContextWatermark(db, caller, vaultId, 9000);

      const clientSinceMs = 100; // deliberately much older — asking to catch up further back
      const stored = readContextWatermark(db, caller, vaultId);
      const effectiveSinceMs = floor(clientSinceMs, stored);
      // min(100, 9000) = 100 — the floor never makes the window NARROWER than what the client
      // asked for, only ever WIDER (more inclusive) when the client's own value would have missed
      // something the server knows about.
      expect(effectiveSinceMs).toBe(100);
    });
  });
});
