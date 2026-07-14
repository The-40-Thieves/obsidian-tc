// THE-302: the elicitTtlSeconds config key is wired to the elicit-token mint via a process-wide
// default that cli.ts sets from config at startup. These tests assert the minted token's lifetime
// tracks the configured default and that an explicit per-call ttlSeconds still overrides it. The
// afterEach restores the built-in 300s default so state never leaks between tests.
import { afterEach, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { issueElicitToken, setDefaultElicitTtlSeconds } from "../src/elicit";
import { openMemoryDb } from "./helpers";

function freshDb() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function ttlOf(db: ReturnType<typeof freshDb>, token: string): number {
  const row = db
    .prepare("SELECT created_at, expires_at FROM elicit_tokens WHERE token = ?")
    .get(token) as { created_at: number; expires_at: number };
  return row.expires_at - row.created_at;
}

describe("THE-302 elicitTtlSeconds wiring", () => {
  afterEach(() => setDefaultElicitTtlSeconds(300));

  it("mints tokens with the configured default TTL", () => {
    const db = freshDb();
    setDefaultElicitTtlSeconds(1800);
    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "delete_note",
      argsHash: "h",
      caller: "c",
      now: () => 1_000_000,
    });
    expect(ttlOf(db, token)).toBe(1800 * 1000);
  });

  it("still honors an explicit per-call ttlSeconds override", () => {
    const db = freshDb();
    setDefaultElicitTtlSeconds(1800);
    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "x",
      argsHash: "h",
      caller: null,
      ttlSeconds: 60,
      now: () => 2_000_000,
    });
    expect(ttlOf(db, token)).toBe(60 * 1000);
  });

  it("ignores a non-positive override and keeps the previous default", () => {
    const db = freshDb();
    setDefaultElicitTtlSeconds(1800);
    setDefaultElicitTtlSeconds(0); // rejected: expiry can never be disabled
    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "x",
      argsHash: "h",
      caller: null,
      now: () => 3_000_000,
    });
    expect(ttlOf(db, token)).toBe(1800 * 1000);
  });
});
