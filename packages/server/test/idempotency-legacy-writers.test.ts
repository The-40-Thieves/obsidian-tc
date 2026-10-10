// Mixed-version safety. Several processes can share one cache DB, and a process from before the
// principal-scoped idempotency migration keeps running its OLD statements (origin/main
// mcp/registry/idempotency.ts) against the migrated table. Those statements know nothing of a
// principal: they key on (vault_id, key) alone, so any that still executes either inserts a row
// with no owner or matches EVERY principal's row for that key (finalize, mark, delete) and
// overwrites or deletes it. Codex reproduced exactly that against a table whose `principal` had
// DEFAULT ''.
//
// The migrated table must make every legacy statement fail closed: an error (or zero rows), and
// no alice/bob row touched. The server does not refuse to start against a newer schema (migrate.ts
// runs only the migrations it knows, ignoring unknown applied ones), so the table shape is the only
// guard an old binary honours.
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  finalizeIdempotency,
  readIdempotency,
  tryClaimIdempotency,
} from "../src/mcp/registry/idempotency";
import { openMemoryDb } from "./helpers";

/** The statements exactly as origin/main shipped them (idempotency.ts lines 68, 84, 98, 112, 127,
 *  132), with the parameters each call site bound. */
const LEGACY: Array<{ name: string; sql: string; params: unknown[]; kind: "run" | "get" }> = [
  {
    name: "tryClaim INSERT",
    sql: "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)",
    params: ["v1", "K", "kv_put", "h", 5, 99],
    kind: "run",
  },
  {
    name: "read SELECT",
    sql: "SELECT tool_name, args_hash, started_at, completed_at, result, result_size, expires_at, state FROM idempotency_keys WHERE vault_id = ? AND key = ?",
    params: ["v1", "K"],
    kind: "get",
  },
  {
    name: "finalize UPDATE",
    sql: "UPDATE idempotency_keys SET completed_at = ?, result = ?, result_size = ?, state = 'completed' WHERE vault_id = ? AND key = ?",
    params: [7, '{"poisoned":true}', 17, "v1", "K"],
    kind: "run",
  },
  {
    name: "markEffectCommitted UPDATE",
    sql: "UPDATE idempotency_keys SET state = 'effect_committed' WHERE vault_id = ? AND key = ? AND completed_at IS NULL",
    params: ["v1", "K"],
    kind: "run",
  },
  {
    name: "finalizeIndeterminate UPDATE",
    sql: "UPDATE idempotency_keys SET completed_at = ?, result = 'null', result_size = NULL, state = 'indeterminate' WHERE vault_id = ? AND key = ?",
    params: [7, "v1", "K"],
    kind: "run",
  },
  {
    name: "deleteIdempotency DELETE",
    sql: "DELETE FROM idempotency_keys WHERE vault_id = ? AND key = ?",
    params: ["v1", "K"],
    kind: "run",
  },
];

function seeded(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  for (const principal of ["alice", "bob"]) {
    const o = { vaultId: "v1", principal };
    expect(tryClaimIdempotency(db, o, "K", "kv_put", `h-${principal}`, 1, 1000)).toBe("claimed");
  }
  // Alice's is completed, Bob's stays in flight: both shapes a legacy UPDATE could damage.
  finalizeIdempotency(db, { vaultId: "v1", principal: "alice" }, "K", '{"mine":"alice"}', 16, 2);
  return db;
}

const dump = (db: Database) =>
  db.prepare("SELECT * FROM idempotency_keys ORDER BY principal").all();

describe("legacy (pre-principal) idempotency statements against the migrated table", () => {
  for (const stmt of LEGACY) {
    it(`${stmt.name} fails closed and touches no principal's row`, () => {
      const db = seeded();
      const before = dump(db);
      expect(before).toHaveLength(2);

      let outcome: unknown;
      let threw = false;
      try {
        const prepared = db.prepare(stmt.sql);
        outcome = stmt.kind === "run" ? prepared.run(...stmt.params) : prepared.get(...stmt.params);
      } catch {
        threw = true;
      }

      // Either the statement errored, or it matched nothing: never a row from another principal.
      if (!threw) {
        if (stmt.kind === "run") expect((outcome as { changes: number }).changes).toBe(0);
        else expect(outcome).toBeUndefined();
      }
      expect(dump(db)).toEqual(before);
    });
  }

  it("the INSERT cannot leave an owner-less row behind", () => {
    const db = seeded();
    const [insert] = LEGACY;
    expect(() => db.prepare(insert?.sql as string).run(...(insert?.params ?? []))).toThrow();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE principal = ''").get(),
    ).toEqual({
      n: 0,
    });
  });

  it("the current code is unaffected: each principal still reads only its own row", () => {
    const db = seeded();
    expect(readIdempotency(db, { vaultId: "v1", principal: "alice" }, "K")?.state).toBe(
      "completed",
    );
    expect(readIdempotency(db, { vaultId: "v1", principal: "bob" }, "K")?.state).toBe("in_flight");
    expect(readIdempotency(db, { vaultId: "v1", principal: "carol" }, "K")).toBeUndefined();
  });

  it("an owner-less row is refused by the schema itself (no default, not blank)", () => {
    const db = seeded();
    const cols = db.prepare("PRAGMA table_info(idempotency_keys)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const principal = cols.find((c) => c.name === "principal");
    expect(principal).toMatchObject({ notnull: 1, dflt_value: null });
    const row = [1, "t", "h", 1, 9] as const;
    expect(() =>
      db
        .prepare(
          "INSERT INTO idempotency_keys (vault_id, principal, idem_key, tool_name, args_hash, started_at, expires_at) VALUES ('v1', '', ?, ?, ?, ?, ?)",
        )
        .run(...row),
    ).toThrow(/CHECK|constraint/i);
  });

  // The harness must be able to FAIL: against the shape this PR first shipped (`key`, and a
  // `principal` that defaults to '') the same legacy statements do corrupt the rows.
  it("control: against the earlier table shape a legacy UPDATE does hit every principal's row", () => {
    const db = openMemoryDb();
    db.exec(`CREATE TABLE idempotency_keys (
      vault_id TEXT NOT NULL, principal TEXT NOT NULL DEFAULT '', key TEXT NOT NULL,
      tool_name TEXT NOT NULL, args_hash TEXT NOT NULL, started_at INTEGER NOT NULL,
      completed_at INTEGER, result BLOB, result_size INTEGER, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'in_flight', PRIMARY KEY (vault_id, principal, key))`);
    for (const p of ["alice", "bob"])
      db.prepare(
        "INSERT INTO idempotency_keys (vault_id, principal, key, tool_name, args_hash, started_at, expires_at) VALUES ('v1', ?, 'K', 't', 'h', 1, 9)",
      ).run(p);
    const finalize = LEGACY[2];
    const r = db.prepare(finalize?.sql as string).run(...(finalize?.params ?? [])) as {
      changes: number;
    };
    expect(r.changes).toBe(2);
  });
});
