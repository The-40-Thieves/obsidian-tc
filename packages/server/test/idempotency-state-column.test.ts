import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";

describe("idempotency_keys.state column (THE-562 #13)", () => {
  it("adds a state column defaulting to 'in_flight'", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const cols = db.prepare("PRAGMA table_info(idempotency_keys)").all() as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const state = cols.find((c) => c.name === "state");
    expect(state, "state column exists").toBeDefined();
    expect(state?.notnull).toBe(1);
    // A row inserted without state gets the default.
    db.prepare(
      "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES ('v','k','t','h',1,NULL,NULL,NULL,999)",
    ).run();
    const row = db.prepare("SELECT state FROM idempotency_keys WHERE key='k'").get() as {
      state: string;
    };
    expect(row.state).toBe("in_flight");
  });
});
